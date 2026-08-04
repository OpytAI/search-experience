/**
 * Local resource diagnostics payload builders (telemetry-free, no ranking lab).
 */

import { compatibilityKeyPrefix, sumAssetBytes } from "../host/reattach-checks.js";
import type { SearchExperienceManifest } from "../protocol/manifest.js";

export type DiagnosticsSnapshot = {
  bootMs?: number;
  lastQueryMs?: number;
  lexicalReady: boolean;
  semanticReady: boolean;
  compatibilityKeyPrefix?: string;
  assetBytesTotal?: number;
  phase?: string;
};

export function buildDiagnostics(input: {
  bootMs?: number;
  lastQueryMs?: number;
  lexicalReady?: boolean;
  semanticReady?: boolean;
  compatibilityKey?: string;
  manifest?: SearchExperienceManifest | null;
  phase?: string;
}): DiagnosticsSnapshot {
  const assetBytesTotal = input.manifest
    ? sumAssetBytes(
        input.manifest.assets as unknown as Record<string, { bytes?: number }>,
        input.manifest.model?.assets as Record<string, { bytes?: number }> | undefined,
      )
    : undefined;

  return {
    bootMs: input.bootMs,
    lastQueryMs: input.lastQueryMs,
    lexicalReady: Boolean(input.lexicalReady),
    semanticReady: Boolean(input.semanticReady),
    compatibilityKeyPrefix: input.compatibilityKey
      ? compatibilityKeyPrefix(input.compatibilityKey)
      : undefined,
    assetBytesTotal: assetBytesTotal && assetBytesTotal > 0 ? assetBytesTotal : undefined,
    phase: input.phase,
  };
}
