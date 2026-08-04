/**
 * Pure helpers for strict snapshot reattachment and readiness claims.
 * Used after bootSearchVm restore/create; no VM I/O here.
 */

export type SnapshotResumeMeta = {
  compatibilityKey: string;
  lexicalReady?: boolean;
  semanticReady?: boolean;
  kernelSha256?: string;
  imageSha256?: string;
};

export type ResumeDecision = {
  /** Whether configure may pass resume: true. */
  resume: boolean;
  reason: string;
};

/**
 * Decide warm resume. Fail closed on restore failure, missing meta, or
 * compatibility/kernel/image mismatch.
 */
export function decideResume(input: {
  restored: boolean;
  expectedCompatibilityKey: string;
  snapshotMeta: SnapshotResumeMeta | null | undefined;
  restoreError?: string;
  /** Expected digests from the current release (when known). */
  expectedKernelSha256?: string;
  expectedImageSha256?: string;
}): ResumeDecision {
  if (input.restoreError) {
    return { resume: false, reason: `restore failed: ${input.restoreError}` };
  }
  if (!input.restored) {
    return { resume: false, reason: "cold boot" };
  }
  const meta = input.snapshotMeta;
  if (!meta) {
    return { resume: false, reason: "missing snapshot metadata" };
  }
  if (meta.compatibilityKey !== input.expectedCompatibilityKey) {
    return { resume: false, reason: "compatibility key mismatch" };
  }
  if (
    input.expectedKernelSha256 &&
    meta.kernelSha256 &&
    meta.kernelSha256 !== input.expectedKernelSha256
  ) {
    return { resume: false, reason: "kernel digest mismatch" };
  }
  if (
    input.expectedImageSha256 &&
    meta.imageSha256 &&
    meta.imageSha256 !== input.expectedImageSha256
  ) {
    return { resume: false, reason: "image digest mismatch" };
  }
  if (!meta.lexicalReady) {
    return { resume: false, reason: "snapshot not lexical-ready" };
  }
  return { resume: true, reason: "warm resume" };
}

/**
 * Fail-closed configure resume flag: never resume when restore failed or
 * compatibility is bad, even if a caller still passes resume: true.
 */
export function configureResumeAllowed(
  intendedResume: boolean,
  restoreFailed: boolean,
  compatibilityOk: boolean,
): boolean {
  if (restoreFailed || !compatibilityOk) return false;
  return intendedResume;
}

export type StatusProbeInput = {
  ok: boolean;
  status?: {
    lexicalReady?: boolean;
    semanticReady?: boolean;
    phase?: string;
    message?: string;
  };
  error?: string;
};

export type StatusProbeResult = {
  probeOk: boolean;
  lexicalReady: boolean;
  /**
   * Guest-authoritative: when the probe succeeds and guest claims
   * semanticReady, trust it (no host re-verification of vectors).
   */
  semanticReady: boolean;
  error?: string;
};

/**
 * Evaluate a post-boot serviceCall("searchd", status) probe.
 * On failure: clear error and do not claim ready.
 * On success: trust guest semantic claim when present.
 */
export function evaluateSearchdStatusProbe(input: StatusProbeInput): StatusProbeResult {
  if (!input.ok) {
    return {
      probeOk: false,
      lexicalReady: false,
      semanticReady: false,
      error: input.error ?? "searchd status probe failed",
    };
  }
  if (!input.status) {
    return {
      probeOk: false,
      lexicalReady: false,
      semanticReady: false,
      error: "searchd status response missing status body",
    };
  }
  return {
    probeOk: true,
    lexicalReady: Boolean(input.status.lexicalReady),
    // Trust guest semantic claim when status succeeds.
    semanticReady: Boolean(input.status.semanticReady),
  };
}

/**
 * Whether the host may surface semantic readiness to the page.
 * Requires a successful status probe; trusts guest semanticReady only then.
 * Semantic without lexical is incoherent — reject.
 */
export function semanticClaimAllowed(
  probeOk: boolean,
  status: { semanticReady?: boolean; lexicalReady?: boolean } | undefined | null,
): boolean {
  if (!probeOk || !status) return false;
  if (!status.lexicalReady) return false;
  return Boolean(status.semanticReady);
}

/** Short prefix of a compatibility key for diagnostics (non-sensitive). */
export function compatibilityKeyPrefix(key: string, length = 12): string {
  if (!key) return "";
  return key.slice(0, Math.max(0, length));
}

/** Sum of known asset byte totals from a manifest-shaped assets map. */
export function sumAssetBytes(
  assets: Record<string, { bytes?: number } | undefined> | null | undefined,
  modelAssets?: Record<string, { bytes?: number } | undefined> | null,
): number {
  let total = 0;
  const add = (map: Record<string, { bytes?: number } | undefined> | null | undefined) => {
    if (!map) return;
    for (const value of Object.values(map)) {
      if (value && typeof value.bytes === "number" && Number.isFinite(value.bytes) && value.bytes > 0) {
        total += value.bytes;
      }
    }
  };
  add(assets);
  add(modelAssets ?? undefined);
  return total;
}
