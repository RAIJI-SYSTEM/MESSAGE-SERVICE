import { describe, expect, it } from "vitest";
import { auditAction, auditEntity, buildAuditEvent } from "../../src/modules/audit/audit-event";

const oid = "0123456789abcdef01234567";

describe("auditoria do chat", () => {
  it("mapeia ações de mensagem, conversa e grupo", () => {
    expect(auditAction("POST", `/conversations/${oid}/messages`)).toBe("MESSAGE_SENT");
    expect(auditAction("POST", `/conversations/${oid}/attachments`)).toBe("ATTACHMENT_CREATED");
    expect(auditAction("POST", `/conversations/${oid}/read`)).toBe("CONVERSATION_READ");
    expect(auditAction("POST", `/conversations/${oid}/members`)).toBe("MEMBER_ADDED");
    expect(auditAction("DELETE", `/conversations/${oid}/members/${oid}`)).toBe("MEMBER_REMOVED");
    expect(auditAction("PATCH", `/conversations/${oid}`)).toBe("CONVERSATION_UPDATED");
    expect(auditAction("POST", "/conversations/direct")).toBe("CONVERSATION_OPENED");
    expect(auditAction("POST", "/groups")).toBe("GROUP_CREATED");
    expect(auditAction("DELETE", `/groups/${oid}`)).toBe("GROUP_DELETED");
    expect(auditAction("POST", "/users")).toBe("USER_CREATED");
    expect(auditAction("DELETE", `/users/${oid}`)).toBe("USER_DELETED");
    expect(auditAction("GET", "/conversations")).toBe("HTTP_GET");
  });

  it("extrai o recurso sem confundir query string", () => {
    expect(auditEntity(`/conversations/${oid}/messages?limit=10`)).toEqual({
      entityType: "CONVERSATION",
      entityId: oid,
    });
    expect(auditEntity("/groups")).toEqual({ entityType: "GROUP", entityId: null });
    expect(auditEntity("/users/b8557807-285f-4dd1-b7ec-289357f7e043")).toEqual({
      entityType: "USER",
      entityId: "b8557807-285f-4dd1-b7ec-289357f7e043",
    });
    expect(auditEntity("/conversations/by-ride/6025d0d1-136e-4358-a736-a6edef66d6c9")).toEqual({
      entityType: "RIDE",
      entityId: "6025d0d1-136e-4358-a736-a6edef66d6c9",
    });
    expect(auditEntity("/health")).toEqual({ entityType: "HTTP", entityId: null });
  });

  it("monta evento autenticado de escrita sem conteúdo", () => {
    const event = buildAuditEvent({
      actorSub: "user-1",
      actorName: "Maria",
      method: "post",
      path: `/conversations/${oid}/messages?foo=bar`,
      status: 201,
      durationMs: 12.345,
      requestId: "req-1",
      ip: "10.0.0.1",
      userAgent: "test",
    });

    expect(event).toMatchObject({
      service: "message-service",
      event: "http_request",
      actorSub: "user-1",
      actorName: "Maria",
      method: "POST",
      path: `/conversations/${oid}/messages`,
      status: 201,
      durationMs: 12.35,
      requestId: "req-1",
      action: "MESSAGE_SENT",
      entityType: "CONVERSATION",
      entityId: oid,
      persisted: true,
    });
    expect(JSON.stringify(event)).not.toContain("foo=bar");
  });

  it("não persiste leitura nem requisição anônima", () => {
    const read = buildAuditEvent({
      actorSub: "user-1",
      method: "GET",
      path: "/conversations",
      status: 200,
      durationMs: 1,
      requestId: "r1",
    });
    expect(read.persisted).toBe(false);
    expect(read.action).toBe("HTTP_GET");

    const anonymous = buildAuditEvent({
      method: "POST",
      path: "/conversations/direct",
      status: 201,
      durationMs: 1,
      requestId: "r2",
    });
    expect(anonymous.persisted).toBe(false);
  });
});
