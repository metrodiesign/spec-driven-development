// Hypothesis engine unit tests (REQ-5). A FAKE executor returns scripted probe
// outcomes so the engine's control flow is exercised host-independently (the real
// sandboxed executor path is covered by the darwin-gated loop test).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBudget } from '../budget/budget.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { createExecutor } from '../executor/executor.ts';
import { createDefaultPathPolicy } from '../executor/path-policy.ts';
import { openEventLog } from '../state/event-log.ts';
import { evaluateHypotheses, type HypothesisEngineDeps } from './hypothesis.ts';
import type { ExecuteOutcome, Executor } from '../executor/executor.ts';
import type { Action, BudgetLimits, Hypothesis } from '../types.ts';

const LIMITS: BudgetLimits = { maxIterations: 100, maxCostUnits: 1000, maxWallclockMs: 60_000 };

/** Scripted per-command probe result. */
type Scripted =
  | { kind: 'output'; text: string; exit: number }
  | { kind: 'reject' }
  | { kind: 'onrun'; text: string; exit: number; onRun: () => void };

function harness(script: (cmd: string) => Scripted, opts?: { limits?: BudgetLimits; clock?: { now(): number } }) {
  const dir = mkdtempSync(join(tmpdir(), 'hyp-'));
  const clock = opts?.clock ?? { now: () => 1_000_000 };
  const evidence = createEvidenceStore(join(dir, 'evidence'));
  const log = openEventLog(join(dir, 'events.db'), clock);
  const budget = createBudget(opts?.limits ?? LIMITS, clock);

  const runCmds: string[] = [];
  const executor: Executor = {
    async execute(action: Action, role): Promise<ExecuteOutcome> {
      assert.equal(action.type, 'RUN_COMMAND', 'engine only issues RUN_COMMAND probes');
      assert.equal(role, 'diagnostician', 'probes run as the diagnostician (REQ-4.3)');
      if (action.type !== 'RUN_COMMAND') throw new Error('unreachable');
      runCmds.push(action.cmd);
      const s = script(action.cmd);
      if (s.kind === 'reject') {
        return { status: 'rejected', rejection: { actionId: action.actionId, reason: 'sandbox_unavailable', detail: 'no sandbox' } };
      }
      if (s.kind === 'onrun') s.onRun();
      const outputRef = evidence.put(`exit:${s.exit}\n--- stdout ---\n${s.text}\n--- stderr ---\n`);
      return { status: 'applied', actionId: action.actionId, resultHash: 'blob://x', outputRef, exitCode: s.exit };
    },
  };

  const deps: HypothesisEngineDeps = {
    runId: 'RUN-1',
    taskId: 'T-1',
    executor,
    evidence,
    log,
    budget,
    ids: (() => {
      let n = 0;
      return { next: (p: string) => `${p}-${(n += 1)}` };
    })(),
    maxHypotheses: 3,
    maxProbesPerHypothesis: 5,
    probeTimeoutMs: 5_000,
  };
  return { deps, log, evidence, runCmds, cleanup: () => { log.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const hyp = (statement: string, probes: Hypothesis['probes']): Hypothesis => ({
  statement,
  probes,
  ifConfirmed: { patchPlan: `fix: ${statement}`, estimatedBlastRadius: '1 file' },
});

test('confirms at the first matching probe and short-circuits (REQ-5.3/5.4)', async () => {
  const h = harness((cmd) => (cmd === 'a' ? { kind: 'output', text: 'FOUND-A', exit: 0 } : { kind: 'output', text: 'other', exit: 0 }));
  try {
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'a', expected: 'FOUND-A' }, { cmd: 'b', expected: 'never' }])],
      h.deps,
    );
    assert.equal(out.status, 'confirmed');
    if (out.status === 'confirmed') assert.equal(out.hypothesis.ifConfirmed.patchPlan, 'fix: h1');
    assert.deepEqual(h.runCmds, ['a'], 'second probe never runs after a confirm');
    assert.equal(h.log.all({ type: 'HYPOTHESIS_CONFIRMED' }).length, 1);
    assert.equal(h.log.all({ type: 'PROBE_RUN' }).length, 1);
    assert.equal(h.log.all({ type: 'HYPOTHESIS_PROPOSED' })[0]?.payload['count'], 1);
  } finally {
    h.cleanup();
  }
});

test('runs probes cheapest-first: a later probe can still confirm', async () => {
  const h = harness((cmd) => (cmd === 'second' ? { kind: 'output', text: 'HIT', exit: 0 } : { kind: 'output', text: 'miss', exit: 0 }));
  try {
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'first', expected: 'HIT' }, { cmd: 'second', expected: 'HIT' }])],
      h.deps,
    );
    assert.equal(out.status, 'confirmed');
    assert.deepEqual(h.runCmds, ['first', 'second'], 'probes ran in array order until the match');
  } finally {
    h.cleanup();
  }
});

test('refutes when every probe runs without a match; refuted hypotheses persisted (REQ-5.5)', async () => {
  const h = harness(() => ({ kind: 'output', text: 'nope', exit: 0 }));
  try {
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'a', expected: 'zzz' }, { cmd: 'b', expected: 'yyy' }])],
      h.deps,
    );
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') {
      assert.equal(out.reason, 'all_refuted');
      assert.equal(out.log.length, 1);
      assert.equal(out.log[0]?.verdict, 'refuted');
    }
    assert.equal(h.log.all({ type: 'HYPOTHESIS_REFUTED' }).length, 1, 'refutation recorded (kills repeat guessing)');
    assert.equal(h.runCmds.length, 2, 'all probes ran before refuting');
  } finally {
    h.cleanup();
  }
});

test('an errored/timed-out probe marks undecided, never refuted (REQ-5.8)', async () => {
  // Two hypotheses: first rejected (sandbox), second returns a no-clean-exit (timeout) code.
  const h = harness((cmd) => (cmd === 'rej' ? { kind: 'reject' } : { kind: 'output', text: '', exit: -1 }));
  try {
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'rej', expected: 'x' }]), hyp('h2', [{ cmd: 'timeout', expected: 'x' }])],
      h.deps,
    );
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') {
      assert.equal(out.reason, 'all_refuted');
      assert.deepEqual(out.log.map((v) => v.verdict), ['undecided', 'undecided']);
    }
    assert.equal(h.log.all({ type: 'HYPOTHESIS_REFUTED' }).length, 0, 'an execution error is not a refutation');
    const probeRuns = h.log.all({ type: 'PROBE_RUN' });
    assert.ok(probeRuns.every((e) => e.payload['error'] === true), 'both probe runs flagged error');
  } finally {
    h.cleanup();
  }
});

test('rejects an over-cap hypothesis as structured feedback; probes never run (REQ-5.7)', async () => {
  const h = harness(() => ({ kind: 'output', text: 'x', exit: 0 }));
  try {
    const sixProbes = Array.from({ length: 6 }, (_, i) => ({ cmd: `p${i}`, expected: 'x' }));
    const out = await evaluateHypotheses([hyp('too-many', sixProbes)], h.deps);
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') assert.equal(out.log[0]?.verdict, 'undecided');
    assert.equal(h.runCmds.length, 0, 'not one over-cap probe executed');
    const rejected = h.log.all({ type: 'ACTION_REJECTED' });
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.payload['reason'], 'probe_cap_exceeded');
  } finally {
    h.cleanup();
  }
});

test('stops when the hypothesis count exceeds max_hypotheses_per_failure (REQ-5.6)', async () => {
  const h = harness(() => ({ kind: 'output', text: 'nope', exit: 0 }));
  h.deps.maxHypotheses = 1;
  try {
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'a', expected: 'zzz' }]), hyp('h2', [{ cmd: 'b', expected: 'zzz' }])],
      h.deps,
    );
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') {
      assert.equal(out.reason, 'max_hypotheses');
      assert.equal(out.log.length, 1, 'only the capped number of hypotheses were evaluated');
    }
    assert.deepEqual(h.runCmds, ['a'], 'the second (over-cap) hypothesis never ran a probe');
  } finally {
    h.cleanup();
  }
});

test('checks the budget between probes and stops on a wallclock trip (REQ-5.9)', async () => {
  let t = 1_000_000;
  const clock = { now: () => t };
  const h = harness(
    (cmd) => ({ kind: 'onrun', text: 'miss', exit: 0, onRun: cmd === 'slow' ? () => { t += 5_000; } : () => {} }),
    { clock, limits: { maxIterations: 100, maxCostUnits: 1000, maxWallclockMs: 1_000 } },
  );
  try {
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'slow', expected: 'zzz' }, { cmd: 'second', expected: 'zzz' }])],
      h.deps,
    );
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') assert.equal(out.reason, 'wallclock');
    assert.deepEqual(h.runCmds, ['slow'], 'the second probe was gated out by the between-probe budget check');
  } finally {
    h.cleanup();
  }
});

test('AC-13: a hypotheses entry that is not an object is rejected, never a throw out of evaluateHypotheses', async () => {
  // `hypotheses` is the SECOND untrusted array from the model (asHypotheses() in
  // the AAL source is a bare cast). validateHypothesis() typed the entry, but the
  // ACTION_REJECTED log line then read `hypothesis.statement` — so a `null` entry
  // threw a TypeError out of evaluateHypotheses past runTaskLoop (try/finally).
  const h = harness(() => ({ kind: 'output', text: 'x', exit: 0 }));
  h.deps.maxHypotheses = 10;
  try {
    const bad: readonly unknown[] = [null, 42, 'x', [], true];
    const out = await evaluateHypotheses(
      [...bad, hyp('good', [{ cmd: 'a', expected: 'zzz' }])] as unknown as Hypothesis[],
      h.deps,
    );
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') assert.equal(out.reason, 'all_refuted');
    const rejected = h.log.all({ type: 'ACTION_REJECTED' });
    assert.equal(rejected.length, bad.length, 'every bad entry was rejected, none threw');
    assert.equal(rejected[0]?.payload['reason'], 'hypothesis_not_object', 'null entry');
    assert.equal(rejected[0]?.payload['statement'], null, 'no statement read off a non-object');
    // Control: the well-formed entry after the bad ones still ran its probe.
    assert.deepEqual(h.runCmds, ['a']);
  } finally {
    h.cleanup();
  }
});

test('AC-9 (probe path): a probe whose `cwd` is not a string is undecided, never a throw out of evaluateHypotheses', async () => {
  // `hypotheses` is UNTRUSTED end to end: asHypotheses() in the AAL source is a
  // bare cast and validateHypothesis() above only types `cmd`/`expected`, so a
  // model-authored `cwd` reaches the executor raw. Wired to the REAL executor on
  // purpose — the scripted fake above would prove nothing about validate().
  const wt = mkdtempSync(join(tmpdir(), 'hyp-wt-'));
  const h = harness(() => ({ kind: 'output', text: 'x', exit: 0 }));
  try {
    const executor = createExecutor({
      worktreeDir: wt,
      runId: 'RUN-1',
      taskId: 'T-1',
      log: h.log,
      evidence: h.evidence,
      policy: createDefaultPathPolicy(),
      clock: { now: () => 1_000_000 },
    });
    const out = await evaluateHypotheses(
      [hyp('h1', [{ cmd: 'echo hi', expected: 'hi', cwd: 42 }] as unknown as Hypothesis['probes'])],
      { ...h.deps, executor },
    );
    assert.equal(out.status, 'exhausted');
    if (out.status === 'exhausted') {
      assert.equal(out.reason, 'all_refuted');
      assert.equal(out.log[0]?.verdict, 'undecided', 'a rejected probe is undecided, never a refutation');
    }
    assert.equal(
      h.log.all({ type: 'ACTION_REJECTED' })[0]?.payload['reason'],
      'schema_violation',
      'the executor rejected the probe structurally instead of throwing',
    );
  } finally {
    h.cleanup();
    rmSync(wt, { recursive: true, force: true });
  }
});
