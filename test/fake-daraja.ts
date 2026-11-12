import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};

export type Reply = { status: number; body: unknown } | "hang";
export type Handler = (request: RecordedRequest) => Reply | Promise<Reply>;

export const OAUTH_PATH = "/oauth/v1/generate?grant_type=client_credentials";
export const STK_PUSH_PATH = "/mpesa/stkpush/v1/processrequest";
export const STK_QUERY_PATH = "/mpesa/stkpushquery/v1/query";

export const stkPushAccepted = {
  MerchantRequestID: "29115-34620561-1",
  CheckoutRequestID: "ws_CO_020120260030051234567890",
  ResponseCode: "0",
  ResponseDescription: "Success. Request accepted for processing",
  CustomerMessage: "Success. Request accepted for processing",
};

/**
 * A stand-in for Daraja on 127.0.0.1: records every request and answers with
 * per-route handlers, so tests never touch the network.
 */
export const startFakeDaraja = async () => {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, Handler>();
  const hanging = new Set<ServerResponse>();
  let tokensIssued = 0;

  const defaults: Record<string, Handler> = {
    [OAUTH_PATH]: () => {
      tokensIssued += 1;
      return {
        status: 200,
        body: { access_token: `token-${tokensIssued}`, expires_in: "3599" },
      };
    },
    [STK_PUSH_PATH]: () => ({ status: 200, body: stkPushAccepted }),
  };

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request: RecordedRequest = {
      method: req.method!,
      path: req.url!,
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(request);

    const handler = handlers.get(req.url!) ?? defaults[req.url!];
    const reply: Reply = handler
      ? await handler(request)
      : {
          status: 404,
          body: { errorCode: "404.001.01", errorMessage: "Not found" },
        };

    if (reply === "hang") {
      hanging.add(res);
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(
      typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    on: (path: string, handler: Handler) => handlers.set(path, handler),
    reset: () => {
      requests.length = 0;
      handlers.clear();
      tokensIssued = 0;
    },
    to: (path: string) => requests.filter((request) => request.path === path),
    close: async () => {
      for (const res of hanging) res.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
