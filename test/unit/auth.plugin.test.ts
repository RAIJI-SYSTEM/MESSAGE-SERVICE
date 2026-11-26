import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { HttpError } from "../../src/shared/errors";

const { jwtVerify } = vi.hoisted(() => ({ jwtVerify: vi.fn() }));

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => ({ fakeJwks: true })),
  jwtVerify,
}));

async function authApp() {
  const { default: auth } = await import("../../src/plugins/auth");
  const app = Fastify({ logger: false });
  await app.register(auth);
  app.get("/me", { onRequest: app.authenticate }, async (req) => req.user);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
    return reply.code(500).send({ error: "internal" });
  });
  await app.ready();
  return app;
}

beforeEach(() => jwtVerify.mockReset());

describe("plugin de autenticação (Keycloak)", () => {
  it("exige o cabeçalho Bearer", async () => {
    const app = await authApp();
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "missing_token" });
    await app.close();
  });

  it("mapeia sub, nome e papel de admin", async () => {
    jwtVerify.mockResolvedValue({
      payload: { sub: "kc-123", name: "  Ana Souza  ", realm_access: { roles: ["chat-admin"] } },
    });
    const app = await authApp();
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer token" } });
    expect(res.json()).toEqual({ id: "kc-123", isAdmin: true, name: "Ana Souza" });
    expect(jwtVerify).toHaveBeenCalledWith(
      "token",
      { fakeJwks: true },
      expect.objectContaining({ issuer: "http://localhost:8000/realms/raiji", algorithms: ["RS256"] }),
    );
    await app.close();
  });

  it("usa preferred_username quando não há name e não é admin por padrão", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "kc-9", preferred_username: "ana", realm_access: { roles: ["user"] } } });
    const app = await authApp();
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer token" } });
    expect(res.json()).toEqual({ id: "kc-9", isAdmin: false, name: "ana" });
    await app.close();
  });

  it("devolve null quando o token não traz nome", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "kc-9" } });
    const app = await authApp();
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer token" } });
    expect(res.json()).toEqual({ id: "kc-9", isAdmin: false, name: null });
    await app.close();
  });

  it("recusa token sem sub", async () => {
    jwtVerify.mockResolvedValue({ payload: {} });
    const app = await authApp();
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer token" } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "invalid_token" });
    await app.close();
  });

  it("recusa esquema diferente de Bearer", async () => {
    const app = await authApp();
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Basic abc" } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
