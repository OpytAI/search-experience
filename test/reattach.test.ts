/**
 * Strict reattachment helpers, index-lock contract, diagnostics builders.
 */
import { assert } from "./assert.ts";
import {
  compatibilityKeyPrefix,
  configureResumeAllowed,
  decideResume,
  evaluateSearchdStatusProbe,
  semanticClaimAllowed,
  sumAssetBytes,
} from "../src/host/reattach-checks.ts";
import { INDEX_LOCK_NAME, indexLockAvailable } from "../src/worker/indexing-lock.ts";
import { buildDiagnostics } from "../src/worker/diagnostics.ts";

// ── decideResume fail-closed ────────────────────────────────────────────────

{
  const warm = decideResume({
    restored: true,
    expectedCompatibilityKey: "abc",
    snapshotMeta: {
      compatibilityKey: "abc",
      lexicalReady: true,
      kernelSha256: "k".repeat(64),
      imageSha256: "i".repeat(64),
    },
    expectedKernelSha256: "k".repeat(64),
    expectedImageSha256: "i".repeat(64),
  });
  assert(warm.resume === true, "warm resume allowed");
  assert(warm.reason === "warm resume", "warm reason");
}

{
  const cold = decideResume({
    restored: false,
    expectedCompatibilityKey: "abc",
    snapshotMeta: null,
  });
  assert(cold.resume === false, "cold boot no resume");
}

{
  const badKey = decideResume({
    restored: true,
    expectedCompatibilityKey: "expected",
    snapshotMeta: { compatibilityKey: "other", lexicalReady: true },
  });
  assert(badKey.resume === false, "reject key mismatch");
  assert(badKey.reason.includes("compatibility"), "mismatch reason");
}

{
  const restoreFail = decideResume({
    restored: false,
    expectedCompatibilityKey: "abc",
    snapshotMeta: { compatibilityKey: "abc", lexicalReady: true },
    restoreError: "snapshot payload digest mismatch",
  });
  assert(restoreFail.resume === false, "reject after restore error");
  assert(restoreFail.reason.includes("restore failed"), "restore error in reason");
}

{
  const kernelMismatch = decideResume({
    restored: true,
    expectedCompatibilityKey: "abc",
    snapshotMeta: {
      compatibilityKey: "abc",
      lexicalReady: true,
      kernelSha256: "a".repeat(64),
      imageSha256: "i".repeat(64),
    },
    expectedKernelSha256: "b".repeat(64),
    expectedImageSha256: "i".repeat(64),
  });
  assert(kernelMismatch.resume === false, "reject kernel digest mismatch");
}

{
  const notLexical = decideResume({
    restored: true,
    expectedCompatibilityKey: "abc",
    snapshotMeta: { compatibilityKey: "abc", lexicalReady: false },
  });
  assert(notLexical.resume === false, "reject non-lexical snapshot");
}

// ── configureResumeAllowed fail-closed ──────────────────────────────────────

assert(configureResumeAllowed(true, false, true) === true, "resume when healthy");
assert(configureResumeAllowed(true, true, true) === false, "no resume after restore failure");
assert(configureResumeAllowed(true, false, false) === false, "no resume on bad compatibility");
assert(configureResumeAllowed(false, false, true) === false, "honor intended false");

// ── status probe ────────────────────────────────────────────────────────────

{
  const fail = evaluateSearchdStatusProbe({ ok: false, error: "timeout" });
  assert(fail.probeOk === false, "failed probe not ok");
  assert(fail.lexicalReady === false, "failed probe no lexical claim");
  assert(fail.semanticReady === false, "failed probe no semantic claim");
  assert(fail.error?.includes("timeout"), "surface probe error");
}

{
  const missing = evaluateSearchdStatusProbe({ ok: true });
  assert(missing.probeOk === false, "ok without status body fails closed");
  assert(missing.error?.includes("status body"), "missing body error");
}

{
  const trust = evaluateSearchdStatusProbe({
    ok: true,
    status: { lexicalReady: true, semanticReady: true, phase: "semantic_ready" },
  });
  assert(trust.probeOk === true, "probe ok");
  assert(trust.lexicalReady === true, "lexical from guest");
  assert(trust.semanticReady === true, "trust guest semantic claim");
}

{
  const lexicalOnly = evaluateSearchdStatusProbe({
    ok: true,
    status: { lexicalReady: true, semanticReady: false },
  });
  assert(lexicalOnly.semanticReady === false, "no semantic when guest does not claim");
}

// ── semanticClaimAllowed ────────────────────────────────────────────────────

assert(semanticClaimAllowed(true, { lexicalReady: true, semanticReady: true }) === true, "claim allowed");
assert(semanticClaimAllowed(false, { lexicalReady: true, semanticReady: true }) === false, "no claim without probe");
assert(semanticClaimAllowed(true, { lexicalReady: false, semanticReady: true }) === false, "semantic without lexical rejected");
assert(semanticClaimAllowed(true, null) === false, "null status rejected");
assert(semanticClaimAllowed(true, { lexicalReady: true, semanticReady: false }) === false, "guest false");

// ── asset / prefix helpers ──────────────────────────────────────────────────

assert(compatibilityKeyPrefix("abcdefghijklmnop", 8) === "abcdefgh", "prefix length");
assert(compatibilityKeyPrefix("") === "", "empty prefix");
assert(
  sumAssetBytes({ a: { bytes: 10 }, b: { bytes: 20 } }, { m: { bytes: 5 } }) === 35,
  "sum asset bytes",
);
assert(sumAssetBytes({ a: { bytes: 0 }, b: undefined }) === 0, "ignore zero/missing");

// ── index lock contract constants ───────────────────────────────────────────

assert(INDEX_LOCK_NAME === "agentos-search-index", "lock name");
assert(indexLockAvailable(undefined) === false, "no locks");
assert(indexLockAvailable({ request: () => {} }) === true, "locks present");
assert(indexLockAvailable({ request: "not-a-function" }) === false, "non-function request");

// ── diagnostics builder ─────────────────────────────────────────────────────

{
  const d = buildDiagnostics({
    bootMs: 1200,
    lastQueryMs: 42,
    lexicalReady: true,
    semanticReady: false,
    compatibilityKey: "deadbeefcafe0123",
    phase: "lexical_ready",
    manifest: {
      assets: {
        kernel: { bytes: 100 },
        image: { bytes: 200 },
      },
    } as Parameters<typeof buildDiagnostics>[0]["manifest"],
  });
  assert(d.bootMs === 1200, "bootMs");
  assert(d.lastQueryMs === 42, "lastQueryMs");
  assert(d.lexicalReady === true, "diag lexical");
  assert(d.semanticReady === false, "diag semantic");
  assert(d.compatibilityKeyPrefix === "deadbeefcafe", "compat prefix default 12");
  assert(d.assetBytesTotal === 300, "asset total");
  assert(d.phase === "lexical_ready", "phase");
}

console.log("reattach.test.ts: ok");
