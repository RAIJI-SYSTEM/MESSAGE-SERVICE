import type { FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AuthUser } from "../../plugins/auth";
import { buildAuditEvent } from "./audit-event";
import { AuditEventModel } from "./audit.model";

const started = new WeakMap<FastifyRequest, bigint>();

function clientIp(req: FastifyRequest): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip ?? null;
}

/**
 * Auditoria global do chat: registra cada requisição em JSON no stdout e,
 * para requisições autenticadas que mudam estado, grava em `audit_events`.
 *
 * Não registra corpo, texto de mensagem nem anexos.
 */
export default fp(async (app) => {
  app.addHook("onRequest", async (req) => {
    started.set(req, process.hrtime.bigint());
  });

  app.addHook("onResponse", async (req, reply) => {
    if (req.url === "/health") return;

    const begin = started.get(req);
    const durationMs = begin
      ? Number(process.hrtime.bigint() - begin) / 1_000_000
      : 0;
    const user = (req as FastifyRequest & { user?: AuthUser }).user;
    const event = buildAuditEvent({
      actorSub: user?.id ?? null,
      actorName: user?.name ?? null,
      method: req.method,
      path: req.url,
      status: reply.statusCode,
      durationMs,
      requestId: String(req.id),
      ip: clientIp(req),
      userAgent: req.headers["user-agent"] ?? null,
    });

    req.log.info(
      {
        audit: true,
        service: event.service,
        event: event.event,
        actor_sub: event.actorSub,
        actor_username: event.actorName,
        http_method: event.method,
        http_path: event.path,
        http_status: event.status,
        duration_ms: event.durationMs,
        request_id: event.requestId,
        client_ip: event.ip,
        user_agent: event.userAgent,
        action: event.action,
        entity_type: event.entityType,
        entity_id: event.entityId,
        persisted: event.persisted,
      },
      "audit_http_request",
    );

    if (!event.persisted) return;

    AuditEventModel.create(event).catch((err) => {
      req.log.warn({ err }, "falha ao gravar auditoria");
    });
  });
});
