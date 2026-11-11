import { sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

type CheckResult = "ok" | "error";

const checkStatus = z.enum(["ok", "error"]);

const healthResponse = (description: string, healthy: boolean) =>
  z
    .object({
      status: z.enum(["ok", "degraded"]),
      checks: z.object({ db: checkStatus, redis: checkStatus }),
    })
    .describe(description)
    .meta({
      example: healthy
        ? { status: "ok", checks: { db: "ok", redis: "ok" } }
        : { status: "degraded", checks: { db: "ok", redis: "error" } },
    });

const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/health",
    {
      schema: {
        summary: "Check Postgres and Redis",
        tags: ["health"],
        response: {
          200: healthResponse("All dependencies are reachable", true),
          503: healthResponse("At least one dependency is down", false),
        },
      },
    },
    async (request, reply) => {
      const check = async (name: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          return "ok" as CheckResult;
        } catch (err) {
          request.log.error({ err }, `${name} health check failed`);
          return "error" as CheckResult;
        }
      };

      const [db, redis] = await Promise.all([
        check("db", () => app.db.execute(sql`select 1`)),
        check("redis", () => app.redis.ping()),
      ]);

      const healthy = db === "ok" && redis === "ok";

      return reply.code(healthy ? 200 : 503).send({
        status: healthy ? "ok" : "degraded",
        checks: { db, redis },
      });
    },
  );
};

export default healthRoutes;
