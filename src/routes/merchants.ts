import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { accessTokenSecurity, accessTokenUnauthorized } from "./schemas.js";

const merchantRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/me",
    {
      preHandler: app.authenticate,
      schema: {
        summary: "Get the logged-in merchant",
        tags: ["merchants"],
        security: accessTokenSecurity,
        response: {
          200: z
            .object({ id: z.uuid(), email: z.string(), name: z.string() })
            .describe("The merchant the access token belongs to")
            .meta({
              example: {
                id: "5f0c6a3e-8b1d-4c2a-9e7f-1a2b3c4d5e6f",
                email: "owner@duka.co.ke",
                name: "Duka Ltd",
              },
            }),
          401: accessTokenUnauthorized,
        },
      },
    },
    async (request) => {
      const { id, email, name } = request.merchant;
      return { id, email, name };
    },
  );
};

export default merchantRoutes;
