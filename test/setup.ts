/**
 * Shim mínimo do runtime: o MESSAGE-SERVICE usa Bun, mas a única API usada no
 * código é `Bun.env`. Os testes rodam no Vitest/Node com as mesmas variáveis.
 */
(globalThis as unknown as { Bun: { env: NodeJS.ProcessEnv } }).Bun = {
  env: process.env,
};

process.env.NODE_ENV ??= "test";
process.env.KEYCLOAK_ISSUER ??= "http://localhost:8180/realms/raiji";
process.env.KEYCLOAK_JWKS_URL ??=
  "http://localhost:8180/realms/raiji/protocol/openid-connect/certs";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/raiji-test";
