import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * [Análise de Falhas] Job de expiração de conversas.
 *
 * Se a limpeza falhar, o job não pode derrubar o processo: registra o erro e
 * tenta de novo no próximo ciclo. O teste cobre a purga e o agendamento.
 */
const conversationFind = vi.hoisted(() => vi.fn());
const deleteConversation = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/conversations/conversation.model", () => ({
  ConversationModel: { find: conversationFind },
}));
vi.mock("../../src/modules/conversations/conversation.service", () => ({ deleteConversation }));

import {
  purgeExpiredConversations,
  startExpirationJob,
} from "../../src/modules/conversations/expiration.job";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as never;

const chain = (rows: unknown[]) => ({
  limit: () => ({ lean: async () => rows }),
});

beforeEach(() => {
  vi.clearAllMocks();
  deleteConversation.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("[Análise de Falhas] purgeExpiredConversations", () => {
  it("remove cada conversa vencida e registra o resultado", async () => {
    const rows = [
      { _id: "c1", rideId: "r1", expiresAt: new Date("2026-11-20T00:00:00Z") },
      { _id: "c2", rideId: null, expiresAt: new Date("2026-11-21T00:00:00Z") },
    ];
    conversationFind.mockReturnValue(chain(rows));

    await expect(purgeExpiredConversations(log)).resolves.toBe(2);
    expect(deleteConversation).toHaveBeenCalledTimes(2);
    expect(deleteConversation.mock.calls.map((c) => c[0])).toEqual(["c1", "c2"]);
  });

  it("consulta apenas conversas com expiresAt <= agora", async () => {
    conversationFind.mockReturnValue(chain([]));

    await purgeExpiredConversations(log);

    expect(conversationFind).toHaveBeenCalledWith(
      { expiresAt: { $lte: expect.any(Date) } },
      "rideId expiresAt",
    );
  });
});

describe("[Análise de Falhas] startExpirationJob", () => {
  it("executa a limpeza a cada 60s e para no cleanup", async () => {
    vi.useFakeTimers();
    conversationFind.mockReturnValue(chain([{ _id: "c1", rideId: "r1", expiresAt: new Date() }]));

    const stop = startExpirationJob(log);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deleteConversation).toHaveBeenCalledWith("c1");

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deleteConversation).toHaveBeenCalledTimes(1);
  });

  it("falha da limpeza é registrada e não derruba o job", async () => {
    vi.useFakeTimers();
    conversationFind.mockImplementation(() => {
      throw new Error("mongo fora");
    });

    const stop = startExpirationJob(log);
    await vi.advanceTimersByTimeAsync(60_000);

    expect((log as { error: ReturnType<typeof vi.fn> }).error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "falha ao remover conversas expiradas",
    );
    stop();
  });
});
