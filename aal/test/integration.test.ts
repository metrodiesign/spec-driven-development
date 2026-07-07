// Integration: the REAL core loop driven by AALProposalSource (REQ-12.3).
// - a LYING adapter (claims READY, changes nothing) NEVER reaches REVIEWING —
//   the DoD#1 property survives the real Ring-0/Ring-1 plumbing (INV-1/2).
// - an HONEST adapter (writes the fix) reaches REVIEWING via core-run gates.
// Lives in aal/ because Ring 1 may import Ring 0 (INV-8); core/ may NOT import aal.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { createAALProposalSource } from '../src/source.ts';
import { createBreaker, DEFAULT_BREAKER_OPTIONS } from '../src/breaker.ts';
import { createRegistry } from '../src/registry.ts';
import { createRouter } from '../src/router.ts';
import { FakeAdapter } from '../src/fake-adapter.ts';
import { PASS_FAIL_PROBES, type AdapterInterface, type ConformanceRecord } from '../src/protocol.ts';
import {
  buildApprovalPackage,
  createBudget,
  createDefaultPathPolicy,
  createEvidenceStore,
  createExecutor,
  createGateRunner,
  denyNetworkSandbox,
  handleHumanRequest,
  openEventLog,
  runTaskLoop,
  transition,
} from 'core';
import type { ApprovalPackage, BudgetLimits, HandlerDeps, TaskContractExcerpt, TaskState } from 'core';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
function manifestFor(dir: string): string {
  const lines: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name !== '_MANIFEST.sha256') {
      lines.push(`${sha256(readFileSync(join(dir, e.name)))}  ${relative(dir, join(dir, e.name))}`);
    }
  }
  return lines.sort().join('\n') + '\n';
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aal-int-'));
  const wt = join(root, 'target');
  mkdirSync(join(wt, 'src'), { recursive: true });
  mkdirSync(join(wt, 'test', 'golden'), { recursive: true });
  git(wt, 'init', '-q', '-b', 'main');
  git(wt, 'config', 'user.email', 'f@example.invalid');
  git(wt, 'config', 'user.name', 'f');
  writeFileSync(join(wt, 'src', 'impl.txt'), 'wrong\n');
  writeFileSync(join(wt, 'test', 'golden', 'expected.txt'), 'golden truth\n');
  writeFileSync(join(wt, 'test', 'golden', '_MANIFEST.sha256'), manifestFor(join(wt, 'test', 'golden')));
  writeFileSync(join(wt, 'run-tests.sh'), '#!/bin/sh\ngrep -q correct src/impl.txt\n');
  const gateConfigPath = join(wt, 'gate-ladder.json');
  writeFileSync(
    gateConfigPath,
    JSON.stringify({
      t0: { lint: 'true', typecheck: 'true', targetedTests: 'fallback:full_unit' },
      t1: { fullTests: 'sh run-tests.sh', convention: 'builtin', golden: 'builtin' },
      t2: { status: 'not_enabled_phase1' },
      t3: { status: 'not_enabled_phase1' },
    }) + '\n',
  );
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'fixture');
  return { root, wt, gateConfigPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const CONTRACT: TaskContractExcerpt = {
  goalId: 'G-1',
  title: 'make impl correct',
  objective: 'edit src/impl.txt so the tests pass',
  acceptanceCriteria: [{ id: 'AC-1', description: 'src/impl.txt contains correct' }],
};
const LIMITS: BudgetLimits = { maxIterations: 4, maxCostUnits: 500, maxWallclockMs: 60_000 };

function passRecord(id: string): ConformanceRecord {
  return {
    adapterId: id,
    modelVersion: 'x',
    ranAt: '2026-07-06T00:00:00Z',
    probes: PASS_FAIL_PROBES.map((p) => ({ id: p, pass: true, evidenceRef: `blob://${p}` })),
    p7: { susceptibilityScore: 0, evidenceRef: 'blob://p7' },
  };
}

function runWith(adapterFactory: (evidence: ReturnType<typeof createEvidenceStore>) => AdapterInterface) {
  const f = fixture();
  const clock = { now: () => 1_000_000 };
  const log = openEventLog(join(f.root, 'events.db'), clock);
  const evidence = createEvidenceStore(join(f.root, 'evidence'));
  const adapter = adapterFactory(evidence);
  const executor = createExecutor({
    worktreeDir: f.wt,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    policy: createDefaultPathPolicy(),
    sandbox: denyNetworkSandbox(process.platform),
    clock,
  });
  const gates = createGateRunner({
    worktreeDir: f.wt,
    configPath: f.gateConfigPath,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    clock,
  });
  const breaker = createBreaker(DEFAULT_BREAKER_OPTIONS, () => clock.now(), () => {});
  const reg = createRegistry({ breaker });
  reg.register(adapter, passRecord('a'));
  let n = 0;
  const source = createAALProposalSource({
    runId: 'RUN-1',
    taskId: 'T-1',
    router: createRouter(reg),
    breaker,
    worktreeDir: f.wt,
    taskContract: CONTRACT,
    seedPaths: ['src/impl.txt'],
    evidence,
    log,
    ids: { requestId: () => `req-${++n}`, canary: () => 'CANARY' },
    outputSchema: { type: 'object', required: ['claim', 'actionRequests'], properties: { claim: { type: 'string', enum: ['WORKING', 'READY_FOR_VERIFICATION', 'BLOCKED'] }, actionRequests: { type: 'array' } } },
    maxRepairRounds: 2,
  });
  return {
    run: () =>
      runTaskLoop({
        runId: 'RUN-1',
        taskId: 'T-1',
        role: 'implementer',
        source,
        executor,
        gates,
        log,
        budget: createBudget(LIMITS, clock),
        clock,
      }),
    log,
    evidence,
    cleanup: () => { log.close(); f.cleanup(); },
  };
}

test('lying adapter (claims READY, changes nothing) NEVER reaches REVIEWING (REQ-12.3)', async () => {
  const liar: AdapterInterface = {
    manifest: () => ({ adapterId: 'liar', structuredOutput: true, toolCalling: false, contextWindowTokens: 1000, executionBackend: false, determinism: 'none' }),
    async send() {
      return {
        structuredResult: { claim: 'READY_FOR_VERIFICATION', actionRequests: [] },
        actionRequests: [],
        usage: { costUnits: 1, raw: {} },
        rawTranscriptRef: null,
        adapterMeta: { adapterId: 'liar', modelVersion: 'x', interactive: false, toolUseCount: 0 },
      };
    },
  };
  const h = runWith(() => liar);
  try {
    const result = await h.run();
    assert.notEqual(result.finalState, 'REVIEWING', 'a liar must never reach REVIEWING');
    const states = h.log.all({ type: 'TASK_STATE' }).map((e) => String(e.payload['state']));
    assert.ok(!states.includes('REVIEWING'), 'no REVIEWING transition ever recorded');
    assert.equal(result.finalState, 'ESCALATED', 'budget backstop halts the liar');
  } finally {
    h.cleanup();
  }
});

test('honest adapter writes the fix and reaches REVIEWING via core-run gates', async () => {
  const h = runWith((evidence) => new FakeAdapter({ id: 'honest', putContent: (s) => evidence.put(s) }));
  try {
    const result = await h.run();
    assert.equal(result.finalState, 'REVIEWING');
    assert.equal(result.terminalMarker, 'awaiting_human_phase0');
    // Every GATE_RESULT is bound to a worktreeHash (REQ-11.1).
    const gates = h.log.all({ type: 'GATE_RESULT' });
    assert.ok(gates.length >= 1);
    assert.ok(gates.every((g) => /^[0-9a-f]{40}$/.test(String(g.payload['worktreeHash']))));
  } finally {
    h.cleanup();
  }
});

test('E2E: REVIEWING -> Human Plane API approve -> APPROVED (REQ-10.2, REQ-11.1)', async () => {
  const h = runWith((evidence) => new FakeAdapter({ id: 'honest', putContent: (s) => evidence.put(s) }));
  try {
    const result = await h.run();
    assert.equal(result.finalState, 'REVIEWING');

    // Build the approval package for the reviewed task.
    const built = buildApprovalPackage({
      id: 'A-1',
      taskId: 'T-1',
      runId: 'RUN-1',
      goalExcerpt: CONTRACT.objective,
      acIds: ['AC-1'],
      diffRef: 'blob://diff',
      diffLineCount: 10,
      maxDiffBudget: 400,
      gateReports: h.log.all({ type: 'GATE_RESULT' }).map((e) => String(e.payload['worktreeHash'])),
      worktreeHash: 'h',
      assumptions: [],
      unresolvedRisks: [],
      riskClass: 'L2',
      createdAt: 1,
    });
    assert.equal(built.kind, 'package');
    if (built.kind !== 'package') return;

    // The API decision drives the REVIEWING -> APPROVED transition.
    let state: TaskState = 'REVIEWING';
    const deps: Omit<HandlerDeps, 'token'> & { token: string } = {
      runId: 'RUN-1',
      token: 'tok',
      approvals: new Map<string, ApprovalPackage>([['A-1', built.package]]),
      log: h.log,
      onDecision: (_taskId, decision) => {
        const t = transition('REVIEWING', decision === 'approve' ? 'human_approved' : 'changes_requested');
        if (t.ok) state = t.next;
        return t.ok ? { ok: true, state: t.next } : { ok: false, detail: t.detail };
      },
      onKill: () => {},
      rateOk: () => true,
    };
    const res = handleHumanRequest(
      {
        method: 'POST',
        path: '/approvals/A-1',
        headers: { authorization: 'Bearer tok' },
        body: JSON.stringify({ decision: 'approve', attestations: built.package.attestations }),
      },
      deps,
    );
    assert.equal(res.status, 200);
    assert.equal(state, 'APPROVED', 'approval transitioned REVIEWING -> APPROVED');
    assert.equal(h.log.all({ type: 'APPROVAL_RECORDED' }).length, 1);
  } finally {
    h.cleanup();
  }
});
