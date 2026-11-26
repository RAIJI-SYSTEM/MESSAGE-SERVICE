import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AuthUser } from "../../src/plugins/auth";
import { HttpError } from "../../src/shared/errors";

declare module "fastify" {
  interface FastifyInstance {
    authenticate(req: import("fastify").FastifyRequest): Promise<void>;
    publishEvent(exchange: string, routingKey: string, payload: unknown): void;
  }
  interface FastifyRequest {
    user: AuthUser;
  }
}

export const USERS = {
  ana: { id: "user-ana", isAdmin: false, name: "Ana Souza" } satisfies AuthUser,
  bruno: { id: "user-bruno", isAdmin: false, name: "Bruno Lima" } satisfies AuthUser,
  carla: { id: "user-carla", isAdmin: false, name: "Carla Dias" } satisfies AuthUser,
  admin: { id: "user-admin", isAdmin: true, name: "Admin" } satisfies AuthUser,
};

export interface TestApp {
  app: FastifyInstance;
  as(user: AuthUser): void;
  published: { exchange: string; routingKey: string; payload: unknown }[];
}

/**
 * App Fastify mínimo com as mesmas rotas de produção, mas com autenticação
 * substituída (sem Keycloak) e publicação de eventos em memória (sem RabbitMQ).
 */
export async function buildTestApp(...plugins: FastifyPluginAsync[]): Promise<TestApp> {
  const app = Fastify({ logger: false });
  let current: AuthUser = USERS.ana;
  const published: TestApp["published"] = [];

  app.decorateRequest("user");
  app.decorate("authenticate", async (req) => {
    req.user = current;
  });
  app.decorate("publishEvent", (exchange: string, routingKey: string, payload: unknown) => {
    published.push({ exchange, routingKey, payload });
  });

  // Mesmo tratamento de erro do app real (app.ts)
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid_request", issues: err.issues });
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
    if ((err as { code?: unknown }).code === 11000) return reply.code(409).send({ error: "conflict" });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: "invalid_request" });
    return reply.code(500).send({ error: "internal_error" });
  });

  for (const plugin of plugins) await app.register(plugin);
  await app.ready();

  return {
    app,
    as(user) {
      current = user;
    },
    published,
  };
}
