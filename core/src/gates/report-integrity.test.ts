import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openEvidenceAuthenticator } from '../evidence/auth.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import type { GateReport } from '../types.ts';
import { createReportIntegrity } from './report-integrity.ts';

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'report-integrity-'));
  const evidence = createEvidenceStore(join(root, 'evidence'));
  const authenticator = openEvidenceAuthenticator({
    runStateDir: root,
    runId: 'RUN-1',
    recovering: false,
  });
  const integrity = createReportIntegrity({ evidence, authenticator });
  return { root, evidence, integrity, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function unsignedReport(evidenceRef: string): GateReport {
  return {
    tier: 'T1',
    pass: true,
    gateConfigHash: '1'.repeat(64),
    commitHash: '2'.repeat(40),
    worktreeHash: '3'.repeat(40),
    envHash: '4'.repeat(64),
    checks: [{ name: 'fullTests', pass: true, evidenceRef }],
    scopeNote: 'fixture',
  };
}

function expectsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error && 'code' in error && error.code === code;
}

test('REQ-4.6/4.9/4.10: signed gate metadata authenticates run/task/verdicts and dereferenced content hashes', () => {
  const h = harness();
  try {
    const evidenceRef = h.evidence.put('green output\n');
    const report = h.integrity.signGateReport(unsignedReport(evidenceRef), {
      runId: 'RUN-1',
      taskId: 'T-1',
    });

    assert.equal(report.runId, 'RUN-1');
    assert.equal(report.taskId, 'T-1');
    assert.equal(report.auth.version, 'gate-report-v1');
    assert.deepEqual(report.auth.evidence, [
      { evidenceRef, sha256: evidenceRef.slice('blob://'.length) },
    ]);
    assert.doesNotThrow(() =>
      h.integrity.verifyGateReport(report, { runId: 'RUN-1', taskId: 'T-1' }),
    );
  } finally {
    h.cleanup();
  }
});

test('REQ-4.9-4.12: missing, tampered, forged, and wrongly fingerprinted reports fail closed', () => {
  const h = harness();
  try {
    const evidenceRef = h.evidence.put('green output\n');
    const original = h.integrity.signGateReport(unsignedReport(evidenceRef), {
      runId: 'RUN-1',
      taskId: 'T-1',
    });

    const missingHash = structuredClone(original);
    missingHash.auth.evidence = [];
    assert.throws(
      () => h.integrity.verifyGateReport(missingHash, { runId: 'RUN-1', taskId: 'T-1' }),
      expectsCode('content_hash_missing'),
    );

    const forged = structuredClone(original);
    forged.checks[0]!.pass = false;
    assert.throws(
      () => h.integrity.verifyGateReport(forged, { runId: 'RUN-1', taskId: 'T-1' }),
      expectsCode('signature_mismatch'),
    );

    const wrongFingerprint = structuredClone(original);
    wrongFingerprint.auth.keyFingerprint = '0'.repeat(64);
    assert.throws(
      () => h.integrity.verifyGateReport(wrongFingerprint, { runId: 'RUN-1', taskId: 'T-1' }),
      expectsCode('public_key_fingerprint_mismatch'),
    );

    writeFileSync(join(h.root, 'evidence', evidenceRef.slice('blob://'.length)), 'tampered\n');
    assert.throws(
      () => h.integrity.verifyGateReport(original, { runId: 'RUN-1', taskId: 'T-1' }),
      expectsCode('evidence_hash_mismatch'),
    );

    chmodSync(join(h.root, 'evidence'), 0o700);
  } finally {
    h.cleanup();
  }
});

test('REQ-4.9-4.12: report reference is re-dereferenced at a later trust boundary', () => {
  const h = harness();
  try {
    const evidenceRef = h.evidence.put('green output\n');
    const report = h.integrity.signGateReport(unsignedReport(evidenceRef), {
      runId: 'RUN-1',
      taskId: 'T-1',
    });
    const reportRef = h.evidence.put(JSON.stringify(report));
    assert.deepEqual(
      h.integrity.verifyGateReportRef(reportRef, { runId: 'RUN-1', taskId: 'T-1' }),
      report,
    );
    writeFileSync(join(h.root, 'evidence', reportRef.slice('blob://'.length)), 'forged report\n');
    assert.throws(
      () => h.integrity.verifyGateReportRef(reportRef, { runId: 'RUN-1', taskId: 'T-1' }),
      expectsCode('evidence_hash_mismatch'),
    );
  } finally {
    h.cleanup();
  }
});
