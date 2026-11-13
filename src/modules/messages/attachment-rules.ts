/**
 * Regras de anexo — espelham raiji-app/src/utils/attachments.ts.
 * O app valida para dar retorno rápido; aqui é a validação que vale.
 */
export type AttachmentType = "image" | "document" | "audio";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_VOICE_SECONDS = 120;
export const MAX_TEXT_LENGTH = 4000;

/** Por quanto tempo a mídia fica disponível depois do envio */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Validade do link de envio */
export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
/** Validade máxima de um link de download (o app recebe links novos a cada consulta) */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
const DOCUMENT_TYPES = [
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];
const AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac"];

/** "audio/webm;codecs=opus" -> "audio/webm" */
export const baseMimeType = (mimeType: string) => mimeType.split(";")[0]!.trim().toLowerCase();

/** Tipo do anexo pelo MIME, ou null se não for permitido (SVG e HTML ficam de fora por segurança) */
export function attachmentTypeFor(mimeType: string): AttachmentType | null {
  const mime = baseMimeType(mimeType);
  if (IMAGE_TYPES.includes(mime)) return "image";
  if (DOCUMENT_TYPES.includes(mime)) return "document";
  if (AUDIO_TYPES.includes(mime)) return "audio";
  return null;
}
