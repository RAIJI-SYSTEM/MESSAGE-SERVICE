import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Regressão][Análise de Falhas] Eventos de usuário vindos do Keycloak.
 *
 * Payload inválido deve ir para a DLQ (ZodError), e os dois eventos válidos
 * precisam ser idempotentes no serviço.
 */
const ensureUser = vi.hoisted(() => vi.fn());
const deleteUserCascade = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/users/user.service", () => ({ ensureUser, deleteUserCascade }));

import { handleUserEvent, userEventSchema } from "../../src/modules/users/user-events";

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  deleteUserCascade.mockResolvedValue({ deletedConversations: 2 });
});

describe("[Regressão] handleUserEvent", () => {
  it("user.created garante o usuário e registra o evento", async () => {
    await handleUserEvent({ type: "user.created", userId: "u1", realm: "raiji" }, log);

    expect(ensureUser).toHaveBeenCalledWith("u1");
    expect((log as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { userId: "u1" },
      "usuário criado a partir do Keycloak",
    );
  });

  it("user.deleted remove em cascata e registra quantas conversas saíram", async () => {
    await handleUserEvent({ type: "user.deleted", userId: "u2" }, log);

    expect(deleteUserCascade).toHaveBeenCalledWith("u2");
    expect((log as { info: ReturnType<typeof vi.fn> }).info).toHaveBeenCalledWith(
      { userId: "u2", deletedConversations: 2 },
      "usuário removido a partir do Keycloak",
    );
  });

  it("payload inválido lança ZodError (vai para a DLQ)", async () => {
    await expect(handleUserEvent({ type: "user.deleted" }, log)).rejects.toThrow();
    expect(ensureUser).not.toHaveBeenCalled();
    expect(deleteUserCascade).not.toHaveBeenCalled();
  });

  it("tipo desconhecido é rejeitado pelo schema", () => {
    expect(() => userEventSchema.parse({ type: "user.updated", userId: "u1" })).toThrow();
  });
});
