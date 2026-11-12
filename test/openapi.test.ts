import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { buildApp } from "../src/app.js";
import { buildTestApp } from "./helpers.js";

type App = Awaited<ReturnType<typeof buildApp>>;

type MediaType = { schema?: unknown; example?: unknown; examples?: unknown };
type Operation = {
  parameters?: { in: string; schema?: { example?: unknown } }[];
  requestBody?: { content?: Record<string, MediaType> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, MediaType> }
  >;
};
type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
};

const METHODS = ["get", "post", "put", "patch", "delete"];

const hasExample = (media: MediaType | undefined) => {
  const schema = media?.schema as { example?: unknown } | undefined;
  return (
    media?.example !== undefined ||
    media?.examples !== undefined ||
    schema?.example !== undefined
  );
};

describe("OpenAPI", () => {
  let app: App;
  let document: OpenApiDocument;

  beforeAll(async () => {
    app = await buildTestApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    document = res.json();
  });

  afterAll(async () => {
    await app.close();
  });

  const operations = () =>
    Object.entries(document.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => METHODS.includes(method))
        .map(([method, operation]) => ({
          name: `${method.toUpperCase()} ${path}`,
          operation,
        })),
    );

  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(
      document as unknown as Parameters<Validator["validate"]>[0],
    );

    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
    expect(document.openapi).toBe("3.1.0");
  });

  it("documents every route", () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      "/health",
      "/v1/api-keys",
      "/v1/api-keys/{id}",
      "/v1/auth/login",
      "/v1/auth/logout",
      "/v1/auth/refresh",
      "/v1/auth/register",
      "/v1/merchants/me",
      "/v1/payments",
      "/v1/payments/{id}",
    ]);
  });

  it("gives every request body and parameter a schema and an example", () => {
    for (const { name, operation } of operations()) {
      const body = operation.requestBody?.content?.["application/json"];
      if (operation.requestBody) {
        expect(body?.schema, name).toBeDefined();
        expect(hasExample(body), name).toBe(true);
      }
      for (const parameter of operation.parameters ?? []) {
        expect(parameter.schema, name).toBeDefined();
        expect(parameter.schema?.example, name).toBeDefined();
      }
    }
  });

  it("gives every response a description, schema and example", () => {
    for (const { name, operation } of operations()) {
      const responses = Object.entries(operation.responses ?? {});
      expect(responses.length, name).toBeGreaterThan(0);

      for (const [status, response] of responses) {
        const label = `${name} ${status}`;
        expect(response.description, label).not.toBe("Default Response");
        if (status === "204") continue; // No body.
        const json = response.content?.["application/json"];
        expect(json?.schema, label).toBeDefined();
        expect(hasExample(json), label).toBe(true);
      }
    }
  });

  it("serves Swagger UI at /docs", async () => {
    const res = await app.inject({ method: "GET", url: "/docs/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("swagger");
  });
});
