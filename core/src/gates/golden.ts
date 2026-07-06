// Golden harness (spec §6.5, REQ-9): test/golden/** is read-only for every role
// and its _MANIFEST.sha256 is recomputed at T1 — a mismatch fails the gate with
// golden_manifest_mismatch. Phase scope (REQ-9.3): this detects TAMPERING only;
// a vacuous-but-passing generated test is caught by the later RED-check, not here.

export type GoldenVerdict =
  | { ok: true; files: number }
  | { ok: false; reason: 'golden_manifest_mismatch' | 'manifest_missing'; detail: string };

export function verifyGoldenManifest(_worktreeDir: string): GoldenVerdict {
  throw new Error('NotImplemented: verifyGoldenManifest');
}

/** Helper for humans/fixtures freezing a golden dir: compute manifest content. */
export function computeGoldenManifest(_goldenDir: string): string {
  throw new Error('NotImplemented: computeGoldenManifest');
}
