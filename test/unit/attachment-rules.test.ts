import { describe, expect, it } from "vitest";
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

describe("attachment-rules", () => {
  it("normaliza o MIME (codecs, espaços e maiúsculas)", () => {
    expect(baseMimeType(" Audio/WebM;codecs=opus ")).toBe("audio/webm");
    expect(baseMimeType("IMAGE/PNG")).toBe("image/png");
    expect(baseMimeType("application/pdf; charset=binary")).toBe("application/pdf");
  });

  it("reconhece imagens permitidas", () => {
    for (const mime of ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]) {
      expect(attachmentTypeFor(mime)).toBe("image");
    }
  });

  it("reconhece documentos permitidos", () => {
    expect(attachmentTypeFor("application/pdf")).toBe("document");
    expect(attachmentTypeFor("text/plain")).toBe("document");
    expect(attachmentTypeFor("application/msword")).toBe("document");
    expect(attachmentTypeFor("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("document");
    expect(attachmentTypeFor("application/vnd.ms-excel")).toBe("document");
    expect(attachmentTypeFor("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("document");
  });

  it("reconhece áudios permitidos", () => {
    for (const mime of ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac"]) {
      expect(attachmentTypeFor(mime)).toBe("audio");
    }
    expect(attachmentTypeFor("audio/webm;codecs=opus")).toBe("audio");
  });

  it("recusa tipos perigosos ou desconhecidos", () => {
    expect(attachmentTypeFor("image/svg+xml")).toBeNull();
    expect(attachmentTypeFor("text/html")).toBeNull();
    expect(attachmentTypeFor("application/javascript")).toBeNull();
    expect(attachmentTypeFor("")).toBeNull();
  });

  it("mantém os limites combinados com o app", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_ATTACHMENTS_PER_MESSAGE).toBe(5);
    expect(MAX_VOICE_SECONDS).toBe(120);
    expect(MAX_TEXT_LENGTH).toBe(4000);
    expect(ATTACHMENT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(UPLOAD_URL_TTL_SECONDS).toBe(5 * 60);
    expect(DOWNLOAD_URL_TTL_SECONDS).toBe(15 * 60);
  });
});
