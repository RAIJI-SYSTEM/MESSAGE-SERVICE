/**
 * Monta o evento de auditoria do chat sem registrar conteúdo de mensagens.
 * A rota identifica a ação; o corpo e o texto ficam de fora.
 */

export interface AuditEvent {
  service: string;
  event: string;
  actorSub: string | null;
  actorName: string | null;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  persisted: boolean;
  at: Date;
}

export interface AuditEventInput {
  actorSub?: string | null;
  actorName?: string | null;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const OBJECT_ID = /^[a-f0-9]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENTITY_TYPES: Record<string, string> = {
  conversations: "CONVERSATION",
  users: "USER",
  groups: "GROUP",
  rides: "RIDE",
  "by-ride": "RIDE",
};

export function auditAction(method: string, path: string): string {
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/";
  const segments = clean.split("/").filter(Boolean);
  const m = method.toUpperCase();

  if (m === "POST" && clean === "/conversations/direct") return "CONVERSATION_OPENED";
  if (segments[0] === "conversations" && segments.length >= 2) {
    const tail = segments[segments.length - 1];
    if (segments[2] === "messages" && m === "POST") return "MESSAGE_SENT";
    if (segments[2] === "attachments" && m === "POST") return "ATTACHMENT_CREATED";
    if (segments[2] === "read" && m === "POST") return "CONVERSATION_READ";
    if (segments[2] === "members" && m === "POST") return "MEMBER_ADDED";
    if (segments[2] === "members" && m === "DELETE") return "MEMBER_REMOVED";
    if (m === "PATCH") return "CONVERSATION_UPDATED";
    if (m === "DELETE" && tail !== "members") return "CONVERSATION_DELETED";
  }
  if (segments[0] === "groups") {
    if (m === "POST") return "GROUP_CREATED";
    if (m === "PATCH") return "GROUP_UPDATED";
    if (m === "DELETE") return "GROUP_DELETED";
  }
  if (segments[0] === "users") {
    if (m === "POST") return "USER_CREATED";
    if (m === "DELETE") return "USER_DELETED";
    if (m === "GET") return "USER_VIEWED";
  }
  return `HTTP_${m}`;
}

export function auditEntity(path: string): { entityType: string; entityId: string | null } {
  const segments = path.split("?")[0].split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    if (OBJECT_ID.test(segments[i]) || UUID.test(segments[i])) {
      const previous = (segments[i - 1] ?? "").toLowerCase();
      const type = ENTITY_TYPES[previous] ?? previous.replace(/s$/, "").toUpperCase();
      return { entityType: type || "HTTP", entityId: segments[i] };
    }
  }
  if (segments[0] === "conversations") return { entityType: "CONVERSATION", entityId: null };
  if (segments[0] === "groups") return { entityType: "GROUP", entityId: null };
  if (segments[0] === "users") return { entityType: "USER", entityId: null };
  return { entityType: "HTTP", entityId: null };
}

export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  const cleanPath = input.path.split("?")[0];
  const entity = auditEntity(cleanPath);
  const actorSub = input.actorSub ?? null;
  const readOnly = READ_METHODS.has(input.method.toUpperCase());
  return {
    service: "message-service",
    event: "http_request",
    actorSub,
    actorName: input.actorName ?? null,
    method: input.method.toUpperCase(),
    path: cleanPath,
    status: input.status,
    durationMs: Math.round(input.durationMs * 100) / 100,
    requestId: input.requestId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    action: auditAction(input.method, cleanPath),
    entityType: entity.entityType,
    entityId: entity.entityId,
    persisted: Boolean(actorSub) && !readOnly,
    at: new Date(),
  };
}
