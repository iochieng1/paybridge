import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";

import { merchants } from "../db/schema.js";

export type AuthenticatedMerchant = {
  id: string;
  email: string;
  name: string;
};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    merchant: AuthenticatedMerchant;
  }
}

const unauthorized = (reply: FastifyReply) =>
  reply.code(401).send({
    statusCode: 401,
    error: "Unauthorized",
    message: "Missing or invalid access token",
  });

/**
 * preHandler for protected routes: verifies the Bearer access token and loads
 * the merchant into `request.merchant`. Missing, expired, tampered tokens and
 * tokens for deleted merchants all get the same 401.
 */
export const authenticate = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  let merchantId: string;
  try {
    merchantId = (await request.jwtVerify<{ sub: string }>()).sub;
  } catch {
    return unauthorized(reply);
  }

  const [merchant] = await request.server.db
    .select({ id: merchants.id, email: merchants.email, name: merchants.name })
    .from(merchants)
    .where(eq(merchants.id, merchantId))
    .limit(1);

  if (!merchant) {
    return unauthorized(reply);
  }

  request.merchant = merchant;
};
