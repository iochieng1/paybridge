import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";

type CheckResult = "ok" | "error";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (request, reply) => {
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
  });
};

export default healthRoutes;
