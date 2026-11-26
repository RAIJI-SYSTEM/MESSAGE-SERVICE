import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

const { s3send, getSignedUrl, createPresignedPost } = vi.hoisted(() => ({
  s3send: vi.fn(),
  getSignedUrl: vi.fn(),
  createPresignedPost: vi.fn(),
}));

vi.mock("../../src/config/storage", () => ({
  storage: { bucket: "bucket-test", internal: { send: s3send }, signer: { fake: true } },
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl }));
vi.mock("@aws-sdk/s3-presigned-post", () => ({ createPresignedPost }));

import { HttpError } from "../../src/shared/errors";
import { ConversationModel } from "../../src/modules/conversations/conversation.model";
import { MessageModel } from "../../src/modules/messages/message.model";
import { PendingAttachmentModel } from "../../src/modules/messages/attachment.model";
import {
  createUpload,
  deleteConversationMedia,
  listMessages,
  sendMessage,
  toPreviewDto,
} from "../../src/modules/messages/message.service";
import { clearDb, connectTestDb, disconnectTestDb } from "../helpers/db";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

beforeEach(async () => {
  await clearDb();
  s3send.mockReset();
  getSignedUrl.mockReset().mockResolvedValue("https://signed.example/arquivo");
  createPresignedPost.mockReset().mockResolvedValue({
    url: "https://upload.example",
    fields: { key: "conversations/x/y", policy: "policy" },
  });
});

const conversationId = new Types.ObjectId();
const uploaderId = "user-ana";

async function pendingAttachment(overrides: Record<string, unknown> = {}) {
  return PendingAttachmentModel.create({
    _id: new Types.ObjectId(),
    conversationId,
    uploaderId,
    type: "image",
    name: "foto.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 100,
    key: `conversations/${conversationId}/foto`,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

describe("createUpload", () => {
  it("recusa tipo não permitido", async () => {
    await expect(
      createUpload(conversationId, uploaderId, { name: "x.svg", mimeType: "image/svg+xml", sizeBytes: 10 }),
    ).rejects.toMatchObject({ statusCode: 415, code: "unsupported_media_type" });
    expect(await PendingAttachmentModel.countDocuments()).toBe(0);
  });

  it("recusa arquivo acima de 10 MB", async () => {
    await expect(
      createUpload(conversationId, uploaderId, { name: "big.pdf", mimeType: "application/pdf", sizeBytes: 10 * 1024 * 1024 + 1 }),
    ).rejects.toMatchObject({ statusCode: 413, code: "file_too_large" });
  });

  it("registra o anexo pendente e devolve o link de upload", async () => {
    const result = await createUpload(conversationId, uploaderId, {
      name: "foto.jpeg",
      mimeType: "image/jpeg; charset=binary",
      sizeBytes: 1234,
    });

    expect(result.upload).toEqual({
      method: "POST",
      url: "https://upload.example",
      fields: { key: "conversations/x/y", policy: "policy" },
      expiresInSeconds: 300,
    });
    expect(result.attachment).toMatchObject({
      type: "image",
      name: "foto.jpeg",
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      url: null,
      expired: false,
    });

    const saved = await PendingAttachmentModel.findById(result.attachment.id).lean();
    expect(saved?.key).toBe(`conversations/${conversationId}/${result.attachment.id}`);
    expect(createPresignedPost).toHaveBeenCalledOnce();
  });

  it("limita a duração do áudio ao máximo permitido", async () => {
    const result = await createUpload(conversationId, uploaderId, {
      name: "audio.webm",
      mimeType: "audio/webm",
      sizeBytes: 1000,
      durationSeconds: 500,
    });
    const saved = await PendingAttachmentModel.findById(result.attachment.id).lean();
    expect(saved?.type).toBe("audio");
    expect(saved?.durationSeconds).toBe(120);
  });

  it("áudio sem duração informada não grava o campo", async () => {
    const result = await createUpload(conversationId, uploaderId, {
      name: "audio.webm",
      mimeType: "audio/webm",
      sizeBytes: 1000,
    });
    const saved = await PendingAttachmentModel.findById(result.attachment.id).lean();
    expect(saved?.durationSeconds).toBeUndefined();
  });
});

describe("sendMessage", () => {
  it("exige texto ou anexo", async () => {
    await expect(sendMessage(conversationId, uploaderId, { text: "" })).rejects.toMatchObject({
      statusCode: 400,
      code: "empty_message",
    });
  });

  it("recusa mais de 5 anexos", async () => {
    const ids = Array.from({ length: 6 }, () => String(new Types.ObjectId()));
    await expect(sendMessage(conversationId, uploaderId, { attachmentIds: ids })).rejects.toMatchObject({
      statusCode: 400,
      code: "too_many_attachments",
    });
  });

  it("recusa anexo de outra conversa/remetente", async () => {
    await expect(
      sendMessage(conversationId, uploaderId, { attachmentIds: [String(new Types.ObjectId())] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "invalid_attachments" });
  });

  it("recusa anexo expirado", async () => {
    const pending = await pendingAttachment({ expiresAt: new Date(Date.now() - 1000) });
    await expect(
      sendMessage(conversationId, uploaderId, { attachmentIds: [String(pending._id)] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "attachment_expired" });
  });

  it("recusa anexo que não chegou ao S3", async () => {
    const pending = await pendingAttachment();
    s3send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    await expect(
      sendMessage(conversationId, uploaderId, { attachmentIds: [String(pending._id)] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "attachment_not_uploaded" });
  });

  it("trata 403 do S3 como arquivo inexistente", async () => {
    const pending = await pendingAttachment();
    s3send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 } });
    await expect(
      sendMessage(conversationId, uploaderId, { attachmentIds: [String(pending._id)] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "attachment_not_uploaded" });
  });

  it("propaga outros erros do S3", async () => {
    const pending = await pendingAttachment();
    s3send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 500 } });
    await expect(sendMessage(conversationId, uploaderId, { attachmentIds: [String(pending._id)] })).rejects.toEqual({
      $metadata: { httpStatusCode: 500 },
    });
  });

  it("recusa anexo com tamanho diferente do declarado", async () => {
    const pending = await pendingAttachment({ sizeBytes: 100 });
    s3send.mockResolvedValueOnce({ ContentLength: 99 });
    await expect(
      sendMessage(conversationId, uploaderId, { attachmentIds: [String(pending._id)] }),
    ).rejects.toMatchObject({ statusCode: 400, code: "attachment_size_mismatch" });
  });

  it("envia mensagem só com texto", async () => {
    await ConversationModel.create({ _id: conversationId, type: "direct" });
    const sent = await sendMessage(conversationId, uploaderId, { text: "  olá  " });
    expect(sent.text).toBe("  olá  ");
    expect(sent.attachments).toEqual([]);
    expect(sent.senderId).toBe(uploaderId);

    const updated = await ConversationModel.findById(conversationId).lean();
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(updated!.createdAt.getTime());
  });

  it("envia mensagem com anexos validados e gera links de download", async () => {
    await ConversationModel.create({ _id: conversationId, type: "direct" });
    const first = await pendingAttachment({ sizeBytes: 100 });
    const second = await pendingAttachment({ type: "audio", name: "voz.webm", mimeType: "audio/webm", sizeBytes: 200, durationSeconds: 5 });
    s3send.mockResolvedValueOnce({ ContentLength: 100 }).mockResolvedValueOnce({ ContentLength: 200 });

    const sent = await sendMessage(conversationId, uploaderId, {
      text: "com anexos",
      attachmentIds: [String(first._id), String(second._id)],
    });

    expect(sent.attachments).toHaveLength(2);
    expect(sent.attachments[0]).toMatchObject({ type: "image", url: "https://signed.example/arquivo", expired: false });
    expect(sent.attachments[1]).toMatchObject({ type: "audio", durationSeconds: 5 });
    expect(await PendingAttachmentModel.countDocuments()).toBe(0);
    expect(getSignedUrl).toHaveBeenCalledTimes(2);
  });
});

describe("listMessages", () => {
  it("devolve em ordem cronológica e pagina para trás", async () => {
    const base = Date.now() - 10_000;
    await MessageModel.collection.insertMany([
      { _id: new Types.ObjectId(), conversationId, senderId: "a", text: "um", attachments: [], createdAt: new Date(base), updatedAt: new Date(base) },
      { _id: new Types.ObjectId(), conversationId, senderId: "b", text: "dois", attachments: [], createdAt: new Date(base + 1000), updatedAt: new Date(base + 1000) },
      { _id: new Types.ObjectId(), conversationId, senderId: "a", text: "três", attachments: [], createdAt: new Date(base + 2000), updatedAt: new Date(base + 2000) },
    ]);

    const latest = await listMessages(conversationId, { limit: 2 });
    expect(latest.map((m) => m.text)).toEqual(["dois", "três"]);

    const older = await listMessages(conversationId, { limit: 10, before: new Date(base + 2000) });
    expect(older.map((m) => m.text)).toEqual(["um", "dois"]);
  });

  it("mensagem sem texto devolve string vazia", async () => {
    await MessageModel.create({ conversationId, senderId: "a" });
    const [message] = await listMessages(conversationId, { limit: 10 });
    expect(message.text).toBe("");
    expect(message.attachments).toEqual([]);
  });
});

describe("toPreviewDto", () => {
  it("resume a última mensagem sem gerar links", () => {
    const now = Date.now();
    const dto = toPreviewDto({
      _id: new Types.ObjectId(),
      senderId: "user-ana",
      text: null as unknown as string,
      createdAt: new Date(now - 5000),
      attachments: [
        {
          _id: new Types.ObjectId(),
          type: "image",
          name: "foto.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 10,
          key: "k",
          expiresAt: new Date(now + 1000),
        },
        {
          _id: new Types.ObjectId(),
          type: "document",
          name: "doc.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          key: "k2",
          expiresAt: new Date(now - 1000),
        },
      ],
    });

    expect(dto.text).toBe("");
    expect(dto.attachments[0]).toMatchObject({ url: null, expired: false });
    expect(dto.attachments[1]).toMatchObject({ url: null, expired: true });
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it("sem anexos devolve lista vazia", () => {
    const dto = toPreviewDto({
      _id: new Types.ObjectId(),
      senderId: "a",
      text: "oi",
      createdAt: new Date(),
      attachments: null,
    });
    expect(dto.attachments).toEqual([]);
  });
});

describe("deleteConversationMedia", () => {
  it("apaga mensagens, pendentes e objetos no S3", async () => {
    await MessageModel.create({
      conversationId,
      senderId: "a",
      attachments: [{ type: "image", name: "f", mimeType: "image/jpeg", sizeBytes: 1, key: "k1", expiresAt: new Date() }],
    });
    await pendingAttachment({ key: "k2" });
    s3send.mockResolvedValue({});

    await deleteConversationMedia(conversationId);

    expect(await MessageModel.countDocuments()).toBe(0);
    expect(await PendingAttachmentModel.countDocuments()).toBe(0);
    const command = s3send.mock.calls[0]![0] as { input: { Delete: { Objects: { Key: string }[] } } };
    expect(command.input.Delete.Objects.map((o) => o.Key).sort()).toEqual(["k1", "k2"]);
  });

  it("não chama o S3 quando não há arquivos", async () => {
    await deleteConversationMedia(conversationId);
    expect(s3send).not.toHaveBeenCalled();
  });

  it("tolera falha do S3 (lifecycle do bucket limpa depois)", async () => {
    await pendingAttachment({ key: "k3" });
    s3send.mockRejectedValue(new Error("fora do ar"));
    await expect(deleteConversationMedia(conversationId)).resolves.toBeUndefined();
    expect(await PendingAttachmentModel.countDocuments()).toBe(0);
  });
});

describe("contrato de erro", () => {
  it("erros de validação são HttpError", async () => {
    await expect(sendMessage(conversationId, uploaderId, {})).rejects.toBeInstanceOf(HttpError);
  });
});
