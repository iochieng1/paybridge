import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import { jsonSchemaTransform } from "fastify-type-provider-zod";

/**
 * Builds the OpenAPI document from the zod route schemas and serves it at
 * /openapi.json, with Swagger UI at /docs. Must be registered before routes.
 */
export const registerOpenApi = async (app: FastifyInstance) => {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "PayBridge",
        description:
          "M-Pesa payments gateway API. Dashboard routes take a merchant access token from `/v1/auth/login`; payment routes take an API key from `/v1/api-keys`.",
        version: "0.1.0",
        license: { name: "MIT", identifier: "MIT" },
      },
      tags: [
        { name: "auth", description: "Merchant sign-up and sessions" },
        { name: "merchants", description: "The logged-in merchant" },
        { name: "api-keys", description: "Keys for merchant servers" },
        { name: "payments", description: "M-Pesa STK push payments" },
        {
          name: "webhooks",
          description: "Signed notifications of final payment statuses",
        },
        {
          name: "callbacks",
          description: "Called by Safaricom with payment results",
        },
        { name: "health", description: "Liveness and dependencies" },
      ],
      components: {
        securitySchemes: {
          accessToken: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "15-minute access token from `POST /v1/auth/login`.",
          },
          apiKey: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "pb_test_<prefix>_<secret>",
            description: "API key from `POST /v1/api-keys`.",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );
};
