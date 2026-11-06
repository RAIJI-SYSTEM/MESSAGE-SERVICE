import Fastify from "fastify";
import mongo from "./plugins/mongo";


export function buildApp() {
  const app = Fastify({ logger: true });
  app.register(mongo);
  return app;
}
