import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import { ConversationMemberModel } from "../../src/modules/conversations/conversation-member.model";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import { handleUserEvent } from "../../src/modules/users/user-events";
import { UserModel } from "../../src/modules/users/user.model";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(clearDb);

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as FastifyBaseLogger;

describe("handleUserEvent", () => {
  it("user.created cria o usuário (idempotente)", async () => {
    const logger = log();
    await handleUserEvent({ type: "user.created", userId: "kc-1" }, logger);
    await handleUserEvent({ type: "user.created", userId: "kc-1" }, logger);

    expect(await UserModel.countDocuments({ keycloakId: "kc-1" })).toBe(1);
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("user.deleted remove o usuário e o que dependia dele", async () => {
    await handleUserEvent({ type: "user.created", userId: "kc-2" }, log());
    const conversation = await ConversationModel.create({ type: "direct", directKey: "kc-2:kc-3" });
    await ConversationMemberModel.create({ conversationId: conversation._id, userId: "kc-2" });

    const logger = log();
    await handleUserEvent({ type: "user.deleted", userId: "kc-2" }, logger);

    expect(await UserModel.findOne({ keycloakId: "kc-2" })).toBeNull();
    expect(await ConversationModel.findById(conversation._id)).toBeNull();
    expect(logger.info).toHaveBeenCalledWith({ userId: "kc-2", deletedConversations: 1 }, expect.any(String));
  });

  it("payload inválido lança ZodError", async () => {
    await expect(handleUserEvent({ type: "user.deleted" }, log())).rejects.toBeInstanceOf(z.ZodError);
    await expect(handleUserEvent({ type: "outro", userId: "x" }, log())).rejects.toBeInstanceOf(z.ZodError);
  });

  it("ignora campos extras (realm, occurredAt)", async () => {
    await handleUserEvent({ type: "user.created", userId: "kc-3", realm: "raiji", occurredAt: "2026-01-01" }, log());
    expect(await UserModel.findOne({ keycloakId: "kc-3" })).not.toBeNull();
  });
});
