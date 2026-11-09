import type { FastifyPluginAsync } from "fastify";

const merchantRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const { id, email, name } = request.merchant;
    return { id, email, name };
  });
};

export default merchantRoutes;
