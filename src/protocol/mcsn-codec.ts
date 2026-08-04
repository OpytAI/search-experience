/** MCSN on-disk / export payload codec (gzip). */

export const MCSN_PAYLOAD_ENCODING = "gzip" as const;
export type McsnPayloadEncoding = typeof MCSN_PAYLOAD_ENCODING;

const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
/** AgentOS MCSN header magic ("MCSN"). */
const MCSN_MAGIC0 = 0x4d; // M
const MCSN_MAGIC1 = 0x43; // C
const MCSN_MAGIC2 = 0x53; // S
const MCSN_MAGIC3 = 0x4e; // N

/** True when bytes start with the gzip magic (1f 8b). */
export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === GZIP_ID1 && bytes[1] === GZIP_ID2;
}

/** True when bytes look like an AgentOS MCSN header (not a stored payload). */
export function isRawMcsnBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === MCSN_MAGIC0 &&
    bytes[1] === MCSN_MAGIC1 &&
    bytes[2] === MCSN_MAGIC2 &&
    bytes[3] === MCSN_MAGIC3
  );
}

async function transformThrough(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // Copy so the source is a plain ArrayBuffer-backed view (Blob-safe).
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const out = await new Response(new Blob([copy]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

/**
 * Gzip-encode raw MCSN capture bytes for OPFS / export / prewarm assets.
 * Input must be uncompressed MCSN (magic "MCSN").
 */
export async function encodeMcsnPayload(rawMcsn: Uint8Array): Promise<Uint8Array> {
  if (rawMcsn.byteLength === 0) {
    throw new Error("empty MCSN capture");
  }
  if (!isRawMcsnBytes(rawMcsn)) {
    throw new Error("encodeMcsnPayload expects raw MCSN (magic MCSN); refusing non-MCSN input");
  }
  if (isGzipBytes(rawMcsn)) {
    throw new Error("encodeMcsnPayload received gzip bytes; pass raw MCSN only");
  }
  const compressed = await transformThrough(rawMcsn, new CompressionStream("gzip"));
  if (!isGzipBytes(compressed)) {
    throw new Error("gzip encode produced non-gzip output");
  }
  return compressed;
}

/** Gunzip a stored MCSN payload. */
export async function decodeMcsnPayload(stored: Uint8Array): Promise<Uint8Array> {
  if (stored.byteLength === 0) {
    throw new Error("empty MCSN payload");
  }
  if (!isGzipBytes(stored)) {
    throw new Error("MCSN payload is not gzip-encoded");
  }
  const raw = await transformThrough(stored, new DecompressionStream("gzip"));
  if (!isRawMcsnBytes(raw)) {
    throw new Error("gunzip output is not MCSN (corrupt payload?)");
  }
  return raw;
}
