import { Schema, model, type InferSchemaType } from "mongoose";

/** Metadados de um anexo. Os bytes ficam no S3, na chave `key`. */
export const attachmentFields = {
  type: { type: String, enum: ["image", "document", "audio"], required: true },
  name: { type: String, required: true },
  mimeType: { type: String, required: true },
  sizeBytes: { type: Number, required: true },
  durationSeconds: { type: Number },
  key: { type: String, required: true },
  /** Depois disso o chat não gera mais links (o S3 apaga o arquivo pela lifecycle) */
  expiresAt: { type: Date, required: true },
} as const;

/**
 * Upload pendente: o app pediu o link de envio, mas o anexo ainda não entrou numa
 * mensagem. Ao enviar a mensagem o registro sai daqui e é copiado para ela.
 * Pendentes esquecidos somem sozinhos (índice TTL em expiresAt).
 */
const pendingAttachmentSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
    uploaderId: { type: String, required: true }, // keycloakId
    ...attachmentFields,
  },
  { timestamps: true },
);

pendingAttachmentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
pendingAttachmentSchema.index({ conversationId: 1 });

export type PendingAttachment = InferSchemaType<typeof pendingAttachmentSchema>;
export const PendingAttachmentModel = model("PendingAttachment", pendingAttachmentSchema);
