import { describe, expect, it } from "vitest";

/**
 * [Regressão] Regras de anexo do chat.
 *
 * O app valida no cliente, mas a regra que vale é esta. O teste congela os
 * limites e a lista de MIME permitidos (SVG/HTML continuam bloqueados).
 */
import {
  ATTACHMENT_TTL_MS,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TEXT_LENGTH,
  MAX_VOICE_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  attachmentTypeFor,
  baseMimeType,
} from "../../src/modules/messages/attachment-rules";

describe("[Regressão] attachment-rules", () => {
  it("normaliza MIME com parâmetros e caixa", () => {
    expect(baseMimeType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(baseMimeType(" IMAGE/PNG ")).toBe("image/png");
  });

  it("classifica todos os MIME permitidos (imagem, documento e áudio)", () => {
    const permitidos: Array<[string, "image" | "document" | "audio"]> = [
      ["image/jpeg", "image"],
      ["image/png", "image"],
      ["image/webp", "image"],
      ["image/gif", "image"],
      ["image/heic", "image"],
      ["image/heif", "image"],
      ["application/pdf", "document"],
      ["text/plain", "document"],
      ["application/msword", "document"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
      ["application/vnd.ms-excel", "document"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
      ["audio/webm;codecs=opus", "audio"],
      ["audio/ogg", "audio"],
      ["audio/mp4", "audio"],
      ["audio/mpeg", "audio"],
      ["audio/wav", "audio"],
      ["audio/aac", "audio"],
    ];

    for (const [mime, tipo] of permitidos) {
      expect(attachmentTypeFor(mime), mime).toBe(tipo);
    }
  });

  it("bloqueia SVG, HTML e tipos desconhecidos", () => {
    expect(attachmentTypeFor("image/svg+xml")).toBeNull();
    expect(attachmentTypeFor("text/html")).toBeNull();
    expect(attachmentTypeFor("application/x-msdownload")).toBeNull();
  });

  it("mantém os limites usados pelo app", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
    expect(MAX_VOICE_SECONDS).toBe(120);
    expect(MAX_TEXT_LENGTH).toBe(4000);
    expect(ATTACHMENT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(UPLOAD_URL_TTL_SECONDS).toBe(300);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(900);
  });
});
