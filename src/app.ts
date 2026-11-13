import Fastify, { type FastifyError } from "fastify";
import { z } from "zod";
import conversationRoutes from "./modules/conversations/conversation.routes";
import { startExpirationJob } from "./modules/conversations/expiration.job";
import groupRoutes from "./modules/conversations/group.routes";
import messageRoutes from "./modules/messages/message.routes";
import userRoutes from "./modules/users/user.routes";
import auth from "./plugins/auth";
import mongo from "./plugins/mongo";
import rabbitmq from "./plugins/rabbitmq";
import { HttpError } from "./shared/errors";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
    if ((err.code as unknown) === 11000) return reply.code(409).send({ error: "conflict" });
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: "invalid_request", message: err.message });
    }
    req.log.error({ err }, "erro não tratado");
    return reply.code(500).send({ error: "internal_error" });
  });

  // Healthcheck interno (compose/Kong) — fora dos plugins com autenticação
  app.get("/health", async () => ({ status: "ok" }));

  app.register(mongo);
  app.register(rabbitmq); // depois do mongo: os eventos gravam no banco
  app.register(auth);
  app.register(userRoutes);
  app.register(conversationRoutes);
  app.register(groupRoutes);
  app.register(messageRoutes);

  let stopExpirationJob: (() => void) | undefined;
  app.addHook("onReady", async () => {
    stopExpirationJob = startExpirationJob(app.log);
  });
  app.addHook("onClose", async () => stopExpirationJob?.());

  return app;
}
