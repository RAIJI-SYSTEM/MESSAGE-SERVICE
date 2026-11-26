/**
 * Adaptador de ambiente: o serviço roda em Bun (`Bun.env`), mas os testes rodam no
 * Node com Vitest. Nenhum código de src/ é alterado — só expomos `Bun.env`.
 */
const g = globalThis as unknown as { Bun?: { env: Record<string, string | undefined> } };
g.Bun ??= { env: process.env };

process.env.NODE_ENV ??= "test";
process.env.S3_BUCKET ??= "raiji-chat-test";
process.env.AWS_REGION ??= "sa-east-1";
process.env.KEYCLOAK_ISSUER ??= "http://localhost:8000/realms/raiji";
process.env.KEYCLOAK_JWKS_URL ??= "http://localhost:8000/realms/raiji/protocol/openid-connect/certs";
process.env.MONGODB_URI ??= "mongodb://127.0.0.1:27017/raiji-chat-test";
