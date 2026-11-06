import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "../shared/errors";

const ADMIN_ROLE = "chat-admin";
const JWKS_CACHE_MS = 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: string;
  isAdmin: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate(req: FastifyRequest): Promise<void>;
  }
  interface FastifyRequest {
    user: AuthUser;
  }
}

export default fp(async (app) => {
  const issuer = Bun.env.KEYCLOAK_ISSUER!;
  const audience = Bun.env.KEYCLOAK_AUDIENCE || undefined;
  const jwks = createRemoteJWKSet(new URL(Bun.env.KEYCLOAK_JWKS_URL!), {
    cacheMaxAge: JWKS_CACHE_MS,
  });

  app.decorateRequest("user");
  app.decorate("authenticate", async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new HttpError(401, "missing_token");

    try {
      const { payload } = await jwtVerify<{ realm_access?: { roles?: string[] } }>(
        header.slice(7),
        jwks,
        { issuer, audience, algorithms: ["RS256"] },
      );
      if (!payload.sub) throw new Error("token sem sub");
      req.user = {
        id: payload.sub,
        isAdmin: payload.realm_access?.roles?.includes(ADMIN_ROLE) ?? false,
      };
    } catch (err) {
      req.log.debug({ err }, "token inválido");
      throw new HttpError(401, "invalid_token");
    }
  });
});
