import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Types } from "mongoose";
import { storage, type Storage } from "../../config/storage";
import { HttpError } from "../../shared/errors";
import { ConversationModel } from "../conversations/conversation.model";
import {
  ATTACHMENT_TTL_MS,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_VOICE_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  attachmentTypeFor,
  baseMimeType,
} from "./attachment-rules";
import { PendingAttachmentModel } from "./attachment.model";
import { MessageModel } from "./message.model";

type Id = string | Types.ObjectId;

interface AttachmentLike {
  _id: Types.ObjectId;
  type: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds?: number | null;
  key: string;
  expiresAt: Date;
}

interface MessageLike {
  _id: Types.ObjectId;
  senderId: string;
  text?: string | null;
  attachments?: AttachmentLike[] | null;
  createdAt: Date;
}

function requireStorage(): Storage {
  if (!storage) throw new HttpError(503, "storage_unavailable");
  return storage;
}

/** Documento é sempre baixado (nunca aberto como página); foto e áudio abrem no app */
function contentDisposition(attachment: AttachmentLike) {
  if (attachment.type !== "document") return "inline";
  const ascii = attachment.name.replace(/[^\w.\- ]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.name)}`;
}

/** Formato do `Attachment` do app. `url` é null enquanto não enviado ou depois de expirar. */
async function toAttachmentDto(attachment: AttachmentLike, withUrl: boolean) {
  const now = Date.now();
  const expired = attachment.expiresAt.getTime() <= now;
  let url: string | null = null;

  if (withUrl && !expired && storage) {
    const remaining = Math.floor((attachment.expiresAt.getTime() - now) / 1000);
    url = await getSignedUrl(
      storage.signer,
      new GetObjectCommand({
        Bucket: storage.bucket,
        Key: attachment.key,
        ResponseContentType: attachment.mimeType,
        ResponseContentDisposition: contentDisposition(attachment),
      }),
      { expiresIn: Math.max(1, Math.min(DOWNLOAD_URL_TTL_SECONDS, remaining)) },
    );
  }

  return {
    id: String(attachment._id),
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.durationSeconds != null ? { durationSeconds: attachment.durationSeconds } : {}),
    url,
    expiresAt: attachment.expiresAt.toISOString(),
    expired,
  };
}

/** Formato do `ChatMessage` do app */
async function toMessageDto(message: MessageLike) {
  return {
    id: String(message._id),
    senderId: message.senderId,
    text: message.text ?? "",
    attachments: await Promise.all((message.attachments ?? []).map((a) => toAttachmentDto(a, true))),
    sentAt: message.createdAt.toISOString(),
  };
}

export interface UploadRequest {
  name: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds?: number;
}

/**
 * Passo 1 do envio de mídia: registra o anexo pendente e devolve o link de upload.
 * O app envia o arquivo DIRETO ao S3; o próprio S3 recusa tamanho, tipo ou
 * chave diferentes do que foi declarado aqui (condições da policy do POST).
 */
export async function createUpload(conversationId: Id, uploaderId: string, request: UploadRequest) {
  const s3 = requireStorage();
  const mimeType = baseMimeType(request.mimeType);
  const type = attachmentTypeFor(mimeType);
  if (!type) throw new HttpError(415, "unsupported_media_type");
  if (request.sizeBytes > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "file_too_large");

  const id = new Types.ObjectId();
  const pending = await PendingAttachmentModel.create({
    _id: id,
    conversationId,
    uploaderId,
    type,
    name: request.name,
    mimeType,
    sizeBytes: request.sizeBytes,
    durationSeconds:
      type === "audio" && request.durationSeconds !== undefined
        ? Math.min(Math.max(request.durationSeconds, 0), MAX_VOICE_SECONDS)
        : undefined,
    key: `conversations/${conversationId}/${id}`,
    expiresAt: new Date(Date.now() + ATTACHMENT_TTL_MS),
  });

  const { url, fields } = await createPresignedPost(s3.signer, {
    Bucket: s3.bucket,
    Key: pending.key,
    Conditions: [
      ["content-length-range", pending.sizeBytes, pending.sizeBytes],
      ["eq", "$Content-Type", mimeType],
    ],
    Fields: { "Content-Type": mimeType },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });

  return {
    attachment: await toAttachmentDto(pending, false),
    upload: { method: "POST" as const, url, fields, expiresInSeconds: UPLOAD_URL_TTL_SECONDS },
  };
}

async function objectSize(s3: Storage, key: string): Promise<number | null> {
  try {
    const head = await s3.internal.send(new HeadObjectCommand({ Bucket: s3.bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || status === 403) return null; // 403: sem s3:ListBucket o S3 não revela "não existe"
    throw err;
  }
}

/**
 * Passo 2: envia a mensagem com texto e/ou anexos já enviados ao S3.
 * Cada anexo precisa ser do próprio remetente, desta conversa, ainda válido
 * e estar de fato no S3 com o tamanho declarado.
 */
export async function sendMessage(
  conversationId: Id,
  senderId: string,
  { text = "", attachmentIds = [] }: { text?: string; attachmentIds?: string[] },
) {
  const ids = [...new Set(attachmentIds)];
  if (!text && !ids.length) throw new HttpError(400, "empty_message");
  if (ids.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new HttpError(400, "too_many_attachments");

  let attachments: AttachmentLike[] = [];
  if (ids.length) {
    const s3 = requireStorage();
    const pending = await PendingAttachmentModel.find({
      _id: { $in: ids },
      conversationId,
      uploaderId: senderId,
    }).lean();
    if (pending.length !== ids.length) throw new HttpError(400, "invalid_attachments");

    const byId = new Map(pending.map((p) => [String(p._id), p]));
    attachments = ids.map((id) => byId.get(id)!);
    for (const attachment of attachments) {
      if (attachment.expiresAt.getTime() <= Date.now()) throw new HttpError(400, "attachment_expired");
      const size = await objectSize(s3, attachment.key);
      if (size === null) throw new HttpError(400, "attachment_not_uploaded");
      if (size !== attachment.sizeBytes) throw new HttpError(400, "attachment_size_mismatch");
    }
  }

  const message = await MessageModel.create({
    conversationId,
    senderId,
    text,
    attachments: attachments.map(({ _id, type, name, mimeType, sizeBytes, durationSeconds, key, expiresAt }) => ({
      _id,
      type,
      name,
      mimeType,
      sizeBytes,
      durationSeconds,
      key,
      expiresAt,
    })),
  });
  if (ids.length) await PendingAttachmentModel.deleteMany({ _id: { $in: ids } });

  // A lista de conversas é ordenada por atividade recente
  await ConversationModel.updateOne({ _id: conversationId }, { $set: { updatedAt: new Date() } }, { timestamps: false });

  return toMessageDto(message);
}

/** Mensagens em ordem cronológica; `before` pagina para trás (mensagens mais antigas). */
export async function listMessages(conversationId: Id, { limit, before }: { limit: number; before?: Date }) {
  const messages = await MessageModel.find({
    conversationId,
    ...(before ? { createdAt: { $lt: before } } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .lean();

  return Promise.all(messages.reverse().map(toMessageDto));
}

/**
 * Remove mensagens e anexos de uma conversa. Os arquivos no S3 são apagados
 * na hora (economia); se falhar, a lifecycle do bucket apaga em até 1 dia.
 */
export async function deleteConversationMedia(conversationId: Id) {
  const [messages, pending] = await Promise.all([
    MessageModel.find({ conversationId }, "attachments.key").lean(),
    PendingAttachmentModel.find({ conversationId }, "key").lean(),
  ]);
  const keys = [...messages.flatMap((m) => (m.attachments ?? []).map((a) => a.key)), ...pending.map((p) => p.key)];

  if (storage && keys.length) {
    for (let i = 0; i < keys.length; i += 1000) {
      await storage.internal
        .send(
          new DeleteObjectsCommand({
            Bucket: storage.bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        )
        .catch(() => {}); // melhor esforço: a lifecycle garante a limpeza
    }
  }

  await MessageModel.deleteMany({ conversationId });
  await PendingAttachmentModel.deleteMany({ conversationId });
}
