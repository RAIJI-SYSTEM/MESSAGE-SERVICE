import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import {
  purgeExpiredConversations,
  startExpirationJob,
} from "../../src/modules/conversations/expiration.job";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);
afterEach(() => vi.restoreAllMocks());

const log = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) as unknown as FastifyBaseLogger;

describe("purgeExpiredConversations", () => {
  it("remove só as conversas vencidas e devolve a quantidade", async () => {
    const expired = await ConversationModel.create({ type: "group", rideId: "r-1", expiresAt: new Date(Date.now() - 1000) });
    const alive = await ConversationModel.create({ type: "group", rideId: "r-2", expiresAt: new Date(Date.now() + 60_000) });
    await ConversationModel.create({ type: "direct" }); // sem expiração

    const logger = log();
    const removed = await purgeExpiredConversations(logger);

    expect(removed).toBe(1);
    expect(await ConversationModel.findById(expired._id)).toBeNull();
    expect(await ConversationModel.findById(alive._id)).not.toBeNull();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("devolve 0 quando não há nada vencido", async () => {
    const removed = await purgeExpiredConversations(log());
    expect(removed).toBe(0);
  });
});

describe("startExpirationJob", () => {
  it("executa o intervalo, protege contra execução simultânea e registra falhas", async () => {
    // captura o callback do setInterval sem esperar 60 s
    const callbacks: (() => Promise<void>)[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => Promise<void>) => {
      callbacks.push(cb);
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const expired = await ConversationModel.create({ type: "group", rideId: "r-3", expiresAt: new Date(Date.now() - 1000) });
    const logger = log();

    const stop = startExpirationJob(logger);
    expect(callbacks).toHaveLength(1);

    await callbacks[0]!();
    expect(await ConversationModel.findById(expired._id)).toBeNull();

    // erro no meio: loga e continua vivo
    vi.spyOn(ConversationModel, "find").mockImplementationOnce(() => {
      throw new Error("banco fora");
    });
    await callbacks[0]!();
    expect(logger.error).toHaveBeenCalled();

    stop();
  });

  it("ignora disparo enquanto a rodada anterior não terminou", async () => {
    const callbacks: (() => Promise<void>)[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => Promise<void>) => {
      callbacks.push(cb);
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    await ConversationModel.create({ type: "group", rideId: "r-4", expiresAt: new Date(Date.now() - 1000) });
    const logger = log();
    startExpirationJob(logger);

    // duas rodadas ao mesmo tempo: a segunda não faz nada (running = true)
    await Promise.all([callbacks[0]!(), callbacks[0]!()]);
    expect(logger.info).toHaveBeenCalledOnce();
  });
});
