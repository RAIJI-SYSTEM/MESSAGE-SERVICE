import { beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

/**
 * [Regressão][Análise de Falhas] message.service.
 *
 * Cobre o contrato de envio (texto/limites), a prévia usada na lista de
 * conversas e as falhas controladas quando o storage não está configurado.
 */
const messageCreate = vi.hoisted(() => vi.fn());
const messageFind = vi.hoisted(() => vi.fn());
const messageDeleteMany = vi.hoisted(() => vi.fn());
const pendingFind = vi.hoisted(() => vi.fn());
const pendingDeleteMany = vi.hoisted(() => vi.fn());
const conversationUpdateOne = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/messages/message.model", () => ({
  MessageModel: { create: messageCreate, find: messageFind, deleteMany: messageDeleteMany },
}));
vi.mock("../../src/modules/messages/attachment.model", () => ({
  PendingAttachmentModel: { find: pendingFind, deleteMany: pendingDeleteMany },
}));
vi.mock("../../src/modules/conversations/conversation.model", () => ({
  ConversationModel: { updateOne: conversationUpdateOne },
}));

import { HttpError } from "../../src/shared/errors";
import {
  createUpload,
  listMessages,
  sendMessage,
  toPreviewDto,
} from "../../src/modules/messages/message.service";

const expectHttpError = async (promise: Promise<unknown>, status: number, code: string) => {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(HttpError);
  expect(error).toMatchObject({ statusCode: status, code });
};

beforeEach(() => {
  vi.clearAllMocks();
  conversationUpdateOne.mockResolvedValue({});
});

describe("[Análise de Falhas] sendMessage", () => {
  it("recusa mensagem sem texto e sem anexo", async () => {
    await expectHttpError(sendMessage("c1", "u1", { text: "" }), 400, "empty_message");
    await expectHttpError(sendMessage("c1", "u1", { text: "", attachmentIds: [] }), 400, "empty_message");
  });

  it("recusa mais de 5 anexos", async () => {
    const ids = Array.from({ length: 6 }, () => new Types.ObjectId().toString());
    await expectHttpError(sendMessage("c1", "u1", { attachmentIds: ids }), 400, "too_many_attachments");
  });

  it("com anexo e sem storage responde 503 (falha controlada)", async () => {
    await expectHttpError(
      sendMessage("c1", "u1", { attachmentIds: [new Types.ObjectId().toString()] }),
      503,
      "storage_unavailable",
    );
  });

  it("texto puro grava a mensagem e devolve o DTO", async () => {
    const createdAt = new Date("2026-11-26T12:00:00.000Z");
    messageCreate.mockResolvedValue({
      _id: new Types.ObjectId(),
      senderId: "u1",
      text: "olá",
      attachments: [],
      createdAt,
    });

    const dto = await sendMessage("c1", "u1", { text: "olá" });

    expect(dto).toMatchObject({ senderId: "u1", text: "olá", attachments: [], sentAt: createdAt.toISOString() });
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", senderId: "u1", text: "olá" }),
    );
    expect(conversationUpdateOne).toHaveBeenCalledWith(
      { _id: "c1" },
      { $set: { updatedAt: expect.any(Date) } },
      { timestamps: false },
    );
  });
});

describe("[Análise de Falhas] createUpload", () => {
  it("sem S3 configurado responde 503 antes de criar anexo pendente", async () => {
    await expectHttpError(
      createUpload("c1", "u1", { name: "a.png", mimeType: "image/png", sizeBytes: 10 }),
      503,
      "storage_unavailable",
    );
  });
});

describe("[Regressão] prévia e listagem", () => {
  it("toPreviewDto nunca gera URL e marca expiração", () => {
    const agora = Date.now();
    const dto = toPreviewDto({
      _id: new Types.ObjectId(),
      senderId: "u1",
      text: "oi",
      createdAt: new Date(agora),
      attachments: [
        {
          _id: new Types.ObjectId(),
          type: "image",
          name: "a.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          key: "k",
          expiresAt: new Date(agora + 60_000),
        },
        {
          _id: new Types.ObjectId(),
          type: "document",
          name: "b.pdf",
          mimeType: "application/pdf",
          sizeBytes: 20,
          key: "k2",
          expiresAt: new Date(agora - 60_000),
        },
      ],
    });

    expect(dto.text).toBe("oi");
    expect(dto.attachments).toHaveLength(2);
    expect(dto.attachments[0]).toMatchObject({ url: null, expired: false });
    expect(dto.attachments[1]).toMatchObject({ url: null, expired: true });
  });

  it("lista mensagens em ordem cronológica e pagina com before", async () => {
    const antiga = {
      _id: new Types.ObjectId(),
      senderId: "u1",
      text: "primeira",
      attachments: [],
      createdAt: new Date("2026-11-26T10:00:00.000Z"),
    };
    const nova = {
      _id: new Types.ObjectId(),
      senderId: "u2",
      text: "segunda",
      attachments: [],
      createdAt: new Date("2026-11-26T11:00:00.000Z"),
    };

    // O service consulta em ordem decrescente e depois inverte.
    messageFind.mockReturnValue({
      sort: () => ({ limit: () => ({ lean: async () => [nova, antiga] }) }),
    });

    const dto = await listMessages("c1", { limit: 10, before: new Date("2026-11-26T12:00:00.000Z") });

    expect(dto.map((m) => m.text)).toEqual(["primeira", "segunda"]);
    expect(messageFind).toHaveBeenCalledWith({
      conversationId: "c1",
      createdAt: { $lt: new Date("2026-11-26T12:00:00.000Z") },
    });
  });
});
