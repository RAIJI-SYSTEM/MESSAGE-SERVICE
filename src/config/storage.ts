import { S3Client } from "@aws-sdk/client-s3";

/**
 * Armazenamento de mídia (S3 da AWS em produção; RustFS/S3 local em desenvolvimento).
 *
 * Produção:      S3_BUCKET + AWS_REGION. Sem endpoints e sem chaves: o SDK usa a
 *                IAM role da EC2.
 * Desenvolvimento: S3_ENDPOINT (chamadas do chat, rede interna),
 *                S3_PUBLIC_ENDPOINT (host dos links que o app usa, ex.: via Kong),
 *                S3_FORCE_PATH_STYLE=true e AWS_ACCESS_KEY_ID/SECRET do RustFS.
 *
 * Sem S3_BUCKET o chat funciona só com texto (anexos respondem 503).
 */
export interface Storage {
  bucket: string;
  /** Operações do chat (HeadObject, DeleteObject) */
  internal: S3Client;
  /** Só assina links: o host precisa ser o que o app enxerga */
  signer: S3Client;
}

function createStorage(): Storage | null {
  const bucket = Bun.env.S3_BUCKET;
  if (!bucket) return null;

  const region = Bun.env.AWS_REGION || "us-east-1";
  const forcePathStyle = Bun.env.S3_FORCE_PATH_STYLE === "true";
  const client = (endpoint?: string) =>
    new S3Client({
      region,
      forcePathStyle,
      ...(endpoint
        ? {
            endpoint,
            // S3 compatível (RustFS): só envia/valida checksums quando a operação exige
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
          }
        : {}),
    });

  const internalEndpoint = Bun.env.S3_ENDPOINT || undefined;
  return {
    bucket,
    internal: client(internalEndpoint),
    signer: client(Bun.env.S3_PUBLIC_ENDPOINT || internalEndpoint),
  };
}

export const storage = createStorage();
