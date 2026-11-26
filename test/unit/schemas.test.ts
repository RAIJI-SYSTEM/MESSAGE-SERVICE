import { describe, expect, it } from "vitest";

/**
 * [Mutação] Contratos dos schemas compartilhados.
 * RegEx ancorada e limites de paginação não podem virar permissivos.
 */
import { objectIdSchema, paginationSchema } from "../../src/shared/schemas";

describe("[Mutação] objectIdSchema", () => {
  it("aceita exatamente 24 caracteres hexadecimais", () => {
    expect(objectIdSchema.parse("64b7f0a1b2c3d4e5f6a7b8c9")).toBe("64b7f0a1b2c3d4e5f6a7b8c9");
    expect(objectIdSchema.parse("64B7F0A1B2C3D4E5F6A7B8C9")).toBe("64B7F0A1B2C3D4E5F6A7B8C9");
  });

  it("rejeita caracteres antes ou depois dos 24 hex", () => {
    expect(() => objectIdSchema.parse("x64b7f0a1b2c3d4e5f6a7b8c9")).toThrow();
    expect(() => objectIdSchema.parse("64b7f0a1b2c3d4e5f6a7b8c9x")).toThrow();
    expect(() => objectIdSchema.parse("64b7f0a1b2c3d4e5f6a7b8c")).toThrow();
  });
});

describe("[Mutação] paginationSchema", () => {
  it("aplica defaults de limit e offset", () => {
    expect(paginationSchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it("aceita os limites válidos", () => {
    expect(paginationSchema.parse({ limit: 1, offset: 0 })).toEqual({ limit: 1, offset: 0 });
    expect(paginationSchema.parse({ limit: 100, offset: 999 })).toEqual({ limit: 100, offset: 999 });
  });

  it("rejeita limit fora de 1..100 e offset negativo", () => {
    expect(() => paginationSchema.parse({ limit: 0 })).toThrow();
    expect(() => paginationSchema.parse({ limit: 101 })).toThrow();
    expect(() => paginationSchema.parse({ offset: -1 })).toThrow();
  });
});
