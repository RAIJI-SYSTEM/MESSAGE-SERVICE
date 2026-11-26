import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/shared/errors";
import { objectIdSchema, paginationSchema, userIdSchema } from "../../src/shared/schemas";

describe("schemas", () => {
  it("aceita ObjectId de 24 dígitos hexadecimais", () => {
    expect(objectIdSchema.parse("507f1f77bcf86cd799439011")).toBe("507f1f77bcf86cd799439011");
    expect(objectIdSchema.parse("507F1F77BCF86CD799439011")).toBe("507F1F77BCF86CD799439011");
  });

  it("recusa ObjectId inválido", () => {
    expect(() => objectIdSchema.parse("abc")).toThrow();
    expect(() => objectIdSchema.parse("507f1f77bcf86cd79943901z")).toThrow();
  });

  it("userId aceita de 1 a 255 caracteres", () => {
    expect(userIdSchema.parse("u1")).toBe("u1");
    expect(() => userIdSchema.parse("")).toThrow();
    expect(() => userIdSchema.parse("x".repeat(256))).toThrow();
  });

  it("paginação aplica padrões", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it("paginação converte strings e valida limites", () => {
    expect(paginationSchema.parse({ limit: "10", offset: "5" })).toEqual({ limit: 10, offset: 5 });
    expect(paginationSchema.parse({ limit: 100, offset: 0 })).toEqual({ limit: 100, offset: 0 });
    expect(() => paginationSchema.parse({ limit: 0 })).toThrow();
    expect(() => paginationSchema.parse({ limit: 101 })).toThrow();
    expect(() => paginationSchema.parse({ offset: -1 })).toThrow();
    expect(() => paginationSchema.parse({ limit: 1.5 })).toThrow();
  });
});

describe("HttpError", () => {
  it("carrega status e código", () => {
    const err = new HttpError(404, "conversation_not_found");
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("conversation_not_found");
    expect(err.message).toBe("conversation_not_found");
  });
});
