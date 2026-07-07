// Capstone composition E2E (REQ-11.1) with the FakeAdapter — no quota, CI-safe.
// Proves the full wiring (core + AAL + context + adapter -> runTaskLoop on the
// fixture) reaches REVIEWING and the calibration MATH is computed. The numbers
// here are scripted and are NEVER reported as §12 metrics (REQ-11.2); real
// numbers come from a manual live run (task 11 runbook).
//
// Phase 2 (REQ-18.1): the run now starts a live Human Plane server (steering/kill/
// governance wired) and takes an injected Clock; a governance-approved deferred
// quarantine takes effect on load (REQ-9.5).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runSupervisedLoop } from './loop-run.ts';
import { FakeAdapter } from 'aal';
import { approveProposal, openEventLog, proposeFlakyQuarantine, seedFixtureSnapshot, type TaskContract } from 'core';

const CONTRACT: TaskContract = {
  hash: 'a'.repeat(64),
  goal: { id: 'DEMO-1', title: 'demo', objective: 'edit src/impl.txt so the tests pass' },
  acceptanceCriteria: [{ id: 'AC-1', description: 'src/impl.txt contains correct', golden: true }],
  budget: { maxIterations: 4, maxCostUnits: 500, maxWallclockMs: 60_000 },
  approvalPolicy: [],
  raw: {},
};

const clock = { now: () => 1_000_000 };

test('supervised loop with the FakeAdapter reaches REVIEWING; calibration computed (harness math only)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-run-'));
  try {
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
    });
    assert.equal(out.finalState, 'REVIEWING');
    assert.equal(out.calibration.n, 1);
    assert.equal(out.calibration.heldOutPassRate, 1, 'held-out (golden) passed — SCRIPTED, not a §12 metric');
    assert.equal(out.calibration.reproducibility, 1);

    // REQ-18.1: the Human Plane server ran and left its {url,token} discovery file 0600.
    const metaPath = join(persistDir, 'human-plane.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { url: string; token: string };
    assert.match(meta.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(typeof meta.token, 'string');
    assert.equal(statSync(metaPath).mode & 0o777, 0o600, 'discovery file is 0600 (REQ-18.1)');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

// An L1 task (declared risk in the frozen contract) with a golden-backed AC — the
// input the auto-merge gate needs to fire (REQ-7.2).
const L1_CONTRACT: TaskContract = { ...CONTRACT, raw: { risk: 'L1' } };

test('E2E (REQ-18.4): an L1 task auto-merges + the sampled audit reproduces -> COMPLETED', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
  try {
    const out = await runSupervisedLoop({
      contract: L1_CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      // Fixture rate 100 -> the sampled path always runs, deterministically (REQ-18.4).
      autoMerge: { auditSampleRate: 100, depManifestPatterns: ['package.json', 'pnpm-lock.yaml'] },
    });
    assert.equal(out.finalState, 'COMPLETED', 'L0/L1 green + golden ACs auto-merge to COMPLETED');

    // The audit trail proves it was a POLICY decision + a reproduced sampled audit,
    // never a human approval (REQ-7.2/8.2/8.6).
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      const approved = log.all({ type: 'AUTO_APPROVED' });
      assert.equal(approved.length, 1);
      assert.equal(approved[0]?.payload['by'], 'auto_merge_policy');
      assert.equal(log.all({ type: 'AUDIT_SAMPLED' }).length, 1);
      const result = log.all({ type: 'AUDIT_RESULT' }).at(-1);
      assert.equal(result?.payload['sampled'], true);
      assert.equal(result?.payload['reproduced'], true, 'the clean-checkout T1 reproduced the loop T1');
      assert.equal(log.all({ type: 'APPROVAL_RECORDED' }).length, 0, 'no human approval on the auto path');
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test(
  'E2E (REQ-5 production): an L1 task FAILS, self-repairs via a confirmed hypothesis, then auto-merges -> COMPLETED',
  { skip: process.platform !== 'darwin' ? 'darwin-only RUN_COMMAND sandbox (D-003)' : false },
  async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'loop-repair-'));
    try {
      const out = await runSupervisedLoop({
        contract: L1_CONTRACT,
        // `repairable`: writes the wrong marker first (T1 fails -> DIAGNOSING), then the
        // correct one after the hypothesis is confirmed by a real sandboxed probe.
        adapterFactory: (put) => new FakeAdapter({ id: 'fake', behavior: 'repairable', putContent: put }),
        clock,
        persistDir,
        autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
      });
      assert.equal(out.finalState, 'COMPLETED');

      const log = openEventLog(join(persistDir, 'events.db'), clock);
      try {
        // The AAL PRODUCED hypotheses and core PROBED them itself (INV-1): a real probe
        // ran and confirmed, proving the source->loop->engine production path.
        assert.ok(log.all({ type: 'PROBE_RUN' }).length >= 1, 'a probe ran through the executor');
        assert.equal(log.all({ type: 'HYPOTHESIS_CONFIRMED' }).length, 1);
        // ...and the confirmed repair carried on to a reproduced auto-merge.
        assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 1);
        assert.equal(log.all({ type: 'AUDIT_RESULT' }).at(-1)?.payload['reproduced'], true);
      } finally {
        log.close();
      }
    } finally {
      rmSync(persistDir, { recursive: true, force: true });
    }
  },
);

test('a non-golden / no-risk task routes to the approval package — finalState stays REVIEWING (REQ-7.6/7.7)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-appkg-'));
  try {
    // CONTRACT has no `risk` -> defaults to L2 -> approval package, not auto-merge.
    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      autoMerge: { auditSampleRate: 100, depManifestPatterns: [] },
    });
    assert.equal(out.finalState, 'REVIEWING', 'L2 (default) never auto-merges');
    const log = openEventLog(join(persistDir, 'events.db'), clock);
    try {
      assert.equal(log.all({ type: 'AUTO_APPROVED' }).length, 0);
    } finally {
      log.close();
    }
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
  }
});

test('a governance-approved flaky_quarantine takes effect on load — the task is quarantined, never run (REQ-9.5)', async () => {
  const persistDir = mkdtempSync(join(tmpdir(), 'loop-gov-'));
  const policyDir = mkdtempSync(join(tmpdir(), 'loop-pol-'));
  try {
    const logPath = join(persistDir, 'governance.jsonl');
    // Seed an approved policy snapshot (so policy is not the blocker), then approve a
    // deferred flaky_quarantine for T-1 via the CLI-equivalent append.
    seedFixtureSnapshot({ policyDir, logPath, clock });
    const proposal = proposeFlakyQuarantine({ logPath, taskId: 'T-1', clock });
    approveProposal({ logPath, id: proposal.id, clock, decidedBy: 'human' });

    const out = await runSupervisedLoop({
      contract: CONTRACT,
      adapterFactory: (put) => new FakeAdapter({ id: 'fake', putContent: put }),
      clock,
      persistDir,
      governanceLogPath: logPath,
    });
    assert.equal(out.finalState, 'QUARANTINED');
    assert.equal(out.iterations, 0, 'a quarantined task never runs the loop');
  } finally {
    rmSync(persistDir, { recursive: true, force: true });
    rmSync(policyDir, { recursive: true, force: true });
  }
});
