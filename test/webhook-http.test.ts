import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { postWebhook } from "../src/webhooks/http.js";

describe("postWebhook", () => {
  let server: Server;
  let baseUrl: string;
  const hanging = new Set<ServerResponse>();
  const received: {
    path: string;
    headers: Record<string, unknown>;
    body: string;
  }[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push({ path: req.url!, headers: req.headers, body });
      if (req.url === "/hang") {
        hanging.add(res);
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/" }).end();
        return;
      }
      const status = Number(req.url!.slice(1)) || 200;
      res.writeHead(status).end("ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const res of hanging) res.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const allow = { allowPrivateAddresses: true, timeoutMs: 500 };

  it("POSTs the body and headers and reports a 2xx as delivered", async () => {
    const result = await postWebhook(
      `${baseUrl}/204`,
      '{"a":1}',
      { "x-test": "yes" },
      allow,
    );

    expect(result).toEqual({ ok: true, statusCode: 204 });
    const last = received.at(-1)!;
    expect(last.body).toBe('{"a":1}');
    expect(last.headers).toMatchObject({
      "content-type": "application/json",
      "x-test": "yes",
    });
  });

  it.each([500, 503, 404])("reports HTTP %i as a failure", async (status) => {
    expect(await postWebhook(`${baseUrl}/${status}`, "{}", {}, allow)).toEqual({
      ok: false,
      statusCode: status,
      error: `HTTP ${status}`,
    });
  });

  it("does not follow redirects", async () => {
    expect(
      await postWebhook(`${baseUrl}/redirect`, "{}", {}, allow),
    ).toMatchObject({
      ok: false,
      statusCode: 302,
    });
  });

  it("times out a receiver that never answers", async () => {
    const result = await postWebhook(
      `${baseUrl}/hang`,
      "{}",
      {},
      {
        allowPrivateAddresses: true,
        timeoutMs: 100,
      },
    );

    expect(result).toEqual({ ok: false, error: "Timed out after 100 ms" });
  });

  it("reports a refused connection", async () => {
    const result = await postWebhook("http://127.0.0.1:1/", "{}", {}, allow);

    expect(result.ok).toBe(false);
  });

  it("refuses private addresses unless allowed, by IP or by hostname", async () => {
    const before = received.length;
    const port = new URL(baseUrl).port;

    expect(await postWebhook(`${baseUrl}/200`, "{}", {})).toEqual({
      ok: false,
      error: "127.0.0.1 is a non-public address",
    });
    expect(await postWebhook(`http://localhost:${port}/200`, "{}", {})).toEqual(
      {
        ok: false,
        error: "localhost resolves to a non-public address",
      },
    );
    expect(received.length).toBe(before);
  });
});
