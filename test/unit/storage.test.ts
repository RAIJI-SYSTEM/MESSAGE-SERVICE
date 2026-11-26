import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["S3_BUCKET", "AWS_REGION", "S3_FORCE_PATH_STYLE", "S3_ENDPOINT", "S3_PUBLIC_ENDPOINT"] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) original[key] = process.env[key];
  vi.resetModules();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("config/storage", () => {
  it("fica desligado sem S3_BUCKET (chat só com texto)", async () => {
    delete process.env.S3_BUCKET;
    const { storage } = await import("../../src/config/storage");
    expect(storage).toBeNull();
  });

  it("cria os clientes com bucket e defaults", async () => {
    process.env.S3_BUCKET = "bucket-test";
    delete process.env.AWS_REGION;
    delete process.env.S3_FORCE_PATH_STYLE;
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_PUBLIC_ENDPOINT;
    const { storage } = await import("../../src/config/storage");
    expect(storage).not.toBeNull();
    expect(storage!.bucket).toBe("bucket-test");
    expect(storage!.internal).toBeDefined();
    expect(storage!.signer).toBeDefined();
  });

  it("usa endpoints e path style quando configurado (RustFS local)", async () => {
    process.env.S3_BUCKET = "bucket-local";
    process.env.AWS_REGION = "us-east-1";
    process.env.S3_FORCE_PATH_STYLE = "true";
    process.env.S3_ENDPOINT = "http://rustfs:9000";
    process.env.S3_PUBLIC_ENDPOINT = "http://localhost:9000";
    const { storage } = await import("../../src/config/storage");
    expect(storage!.bucket).toBe("bucket-local");
    expect(storage!.internal.config.endpoint).toBeDefined();
    expect(storage!.signer.config.endpoint).toBeDefined();
    expect(storage!.internal.config.forcePathStyle).toBe(true);
  });
});
