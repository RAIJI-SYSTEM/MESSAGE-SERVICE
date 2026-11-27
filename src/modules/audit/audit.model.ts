import mongoose, { Schema } from "mongoose";

/**
 * Trilha de auditoria do chat. Retenção de 180 dias (TTL), sem conteúdo de
 * mensagens. Índices por usuário e por data para consulta rápida.
 */
const AuditEventSchema = new Schema(
  {
    service: { type: String, default: "message-service", index: true },
    event: { type: String, default: "http_request" },
    actorSub: { type: String, index: true },
    actorName: { type: String, default: null },
    method: { type: String, required: true },
    path: { type: String, required: true },
    status: { type: Number, required: true },
    durationMs: { type: Number, required: true },
    requestId: { type: String, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    action: { type: String, required: true, index: true },
    entityType: { type: String, default: "HTTP" },
    entityId: { type: String, default: null },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false, collection: "audit_events" },
);

AuditEventSchema.index({ actorSub: 1, at: -1 });
AuditEventSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });

export const AuditEventModel =
  mongoose.models.AuditEvent ?? mongoose.model("AuditEvent", AuditEventSchema);
