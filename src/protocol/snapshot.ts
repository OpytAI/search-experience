/** Compatibility-keyed OPFS MCSN snapshot metadata. */

import { SEARCHD_PROTOCOL_VERSION, SNAPSHOT_FORMAT_VERSION } from "./versions.js";

export interface SnapshotCompatibility {
  format: typeof SNAPSHOT_FORMAT_VERSION;
  /** Deterministic key: kernel+image+service+schema+model+policy+collections. */
  compatibilityKey: string;
  searchdProtocol: typeof SEARCHD_PROTOCOL_VERSION;
  kernelSha256: string;
  imageSha256: string;
  schemaSha256: string;
  modelFingerprint: string;
  configurationHash: string;
  activeGeneration: string;
  lexicalReady: boolean;
  semanticReady: boolean;
  builtAt: string;
  /**
   * SHA-256 of the **on-disk / exported** payload bytes (gzip).
   * Verified before gunzip on restore.
   */
  snapshotSha256?: string;
  /** On-disk / export payload encoding (`"gzip"`). */
  encoding?: "gzip";
  /** Uncompressed MCSN size in bytes (after gunzip). */
  uncompressedBytes?: number;
  /**
   * MCSN wire kind. Incremental payloads require a content-addressed full base
   * in the AgentOS store (`baseDigest` / header baseId).
   */
  mcsnKind?: "full" | "incremental";
  /** `sha256:…` digest of the full baseline when `mcsnKind` is incremental. */
  baseDigest?: string;
  provenance?: {
    source: "browser" | "publisher";
    pageOrigin?: string;
  };
}

/** Read MCSN kind from payload header (AgentOS snapshot.gen: offset 8, u32 LE). */
export function mcsnKindFromBytes(bytes: Uint8Array): "full" | "incremental" {
  if (bytes.byteLength < 12) return "full";
  const kind = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  return kind === 2 ? "incremental" : "full";
}

/**
 * Read base id from incremental MCSN header and format as `sha256:hex`.
 * Full snapshots have a zero baseId — returns undefined.
 */
export function mcsnBaseDigestFromBytes(bytes: Uint8Array): string | undefined {
  // Header layout (snapshot.gen): magic… baseId at a fixed offset after digests.
  // baseId is 32 bytes; for full kind it is zeros. Parse via kind first.
  if (mcsnKindFromBytes(bytes) !== "incremental" || bytes.byteLength < 128) return undefined;
  // contracts/snapshot.gen.ts: baseId at byte 96 (32 bytes).
  const baseId = bytes.subarray(96, 128);
  if (baseId.every((b) => b === 0)) return undefined;
  const hex = [...baseId].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

export interface SnapshotObjectRecord {
  key: string;
  kind: "full" | "incremental";
  digest: string;
  bytes: number;
  metadata: SnapshotCompatibility;
}

export function snapshotStorageKey(compatibilityKey: string): string {
  return `search-${compatibilityKey}`;
}

export function snapshotMetadataKey(compatibilityKey: string): string {
  return `search-${compatibilityKey}.meta`;
}

/** Stable hash inputs for the compatibility key (caller supplies already-hex digests). */
export async function computeCompatibilityKey(parts: {
  kernelSha256: string;
  imageSha256: string;
  schemaSha256: string;
  modelFingerprint: string;
  configurationHash: string;
  searchdProtocol?: number;
}): Promise<string> {
  const material = [
    `fmt=${SNAPSHOT_FORMAT_VERSION}`,
    `svc=${parts.searchdProtocol ?? SEARCHD_PROTOCOL_VERSION}`,
    `kernel=${parts.kernelSha256}`,
    `image=${parts.imageSha256}`,
    `schema=${parts.schemaSha256}`,
    `model=${parts.modelFingerprint}`,
    `cfg=${parts.configurationHash}`,
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function hashConfiguration(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
