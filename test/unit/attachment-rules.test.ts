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

  it("classifica imagem, documento e áudio permitidos", () => {
    expect(attachmentTypeFor("image/jpeg")).toBe("image");
    expect(attachmentTypeFor("image/heic")).toBe("image");
    expect(attachmentTypeFor("application/pdf")).toBe("document");
    expect(attachmentTypeFor("text/plain")).toBe("document");
    expect(attachmentTypeFor("audio/webm;codecs=opus")).toBe("audio");
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
