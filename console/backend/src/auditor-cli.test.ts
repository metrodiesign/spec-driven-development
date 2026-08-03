// `platform auditor run` — usable with no console server running (REQ-14.7).
// The underlying git/gate mechanics are proven in core/src/audit/oob.test.ts;
// this covers the CLI contract: arg parsing, defaulting, exit codes.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createEvidenceStore,
  createGateRunner,
  createReportIntegrity,
  openEvidenceAuthenticator,
  openEventLog,
  type EventLog,
  type EvidenceStore,
} from 'core';

import { runAuditorCommand } from './auditor-cli.ts';

const now = () => 1_700_000_000_000;
const clock = { now };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface Fixture {
  root: string;
  repoDir: string;
  dbPath: string;
  evidenceDir: string;
  log: EventLog;
  evidence: EvidenceStore;
  cleanup(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'auditorcli-'));
  const repoDir = join(root, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q', '-b', 'main');
  git(repoDir, 'config', 'user.email', 'fixture@example.invalid');
  git(repoDir, 'config', 'user.name', 'fixture');
  writeFileSync(join(repoDir, 'gate-ladder.json'), JSON.stringify({ t1: { fullTests: 'true' } }));
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-q', '-m', 'init');

  const dbPath = join(root, 'events.db');
  const evidenceDir = join(root, 'evidence');
  return {
    root,
    repoDir,
    dbPath,
    evidenceDir,
    log: openEventLog(dbPath, clock),
    evidence: createEvidenceStore(evidenceDir),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function seedCompletedTask(f: Fixture, taskId: string): Promise<void> {
  const mergeCommit = git(f.repoDir, 'rev-parse', 'main').trim();
  const reportIntegrity = createReportIntegrity({
    evidence: f.evidence,
    authenticator: openEvidenceAuthenticator({
      runStateDir: f.root,
      runId: 'RUN-1',
      recovering: false,
      worktreeDirs: [f.repoDir],
    }),
  });
  const gates = createGateRunner({
    worktreeDir: f.repoDir,
    configPath: join(f.repoDir, 'gate-ladder.json'),
    runId: 'RUN-1',
    taskId,
    log: f.log,
    evidence: f.evidence,
    reportIntegrity,
    clock,
  });
  await gates.run('T1');
  f.log.append({ runId: 'RUN-1', taskId, type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
  f.log.append({ runId: 'RUN-1', taskId, type: 'TASK_STATE', payload: { state: 'COMPLETED' } });
}

test('unknown subcommand -> usage error', async () => {
  const f = fixture();
  try {
    const r = await runAuditorCommand({
      argv: ['frobnicate'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /usage/i);
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('run with no eligible targets -> exit 0, says so', async () => {
  const f = fixture();
  try {
    const r = await runAuditorCommand({
      argv: ['run'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /no eligible targets/i);
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('run finds an eligible COMPLETED task at the default rate and reports it reproduced', async () => {
  const f = fixture();
  try {
    await seedCompletedTask(f, 'T-1');
    const r = await runAuditorCommand({
      argv: ['run'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /T-1/);
    assert.match(r.out, /reproduced/);
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('P0-04 H3: auditor derives the single run-scoped evidence store from the selected db', async () => {
  const f = fixture();
  try {
    await seedCompletedTask(f, 'T-1');
    const r = await runAuditorCommand({
      argv: ['run'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });

    assert.equal(r.code, 0);
    assert.match(r.out, /T-1/);
    assert.match(r.out, /reproduced/);
    assert.equal(f.log.all({ type: 'ESCALATED' }).length, 0);
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('P0-04 H4: a COMPLETED target missing its T1 report escalates and exits non-zero', async () => {
  const f = fixture();
  try {
    const mergeCommit = git(f.repoDir, 'rev-parse', 'main').trim();
    f.log.append({ runId: 'RUN-1', taskId: 'T-missing', type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
    f.log.append({ runId: 'RUN-1', taskId: 'T-missing', type: 'TASK_STATE', payload: { state: 'COMPLETED' } });

    const r = await runAuditorCommand({
      argv: ['run'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });

    assert.equal(r.code, 2);
    assert.match(r.err, /gate_report_missing/);
    const escalation = f.log.all({ type: 'ESCALATED' }).at(-1);
    assert.equal(escalation?.payload['boundary'], 'oob_audit');
    assert.equal(escalation?.payload['code'], 'gate_report_missing');
    assert.equal(f.log.all({ type: 'OOB_AUDIT_RESULT' }).length, 0, 'auditor remains detection-only');
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('--rate overrides the default: rate=0 finds nothing even with an eligible task present', async () => {
  const f = fixture();
  try {
    await seedCompletedTask(f, 'T-1');
    const r = await runAuditorCommand({
      argv: ['run', '--rate', '0'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /no eligible targets/i);
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('--db/--repo override the defaults', async () => {
  const f = fixture();
  const wrong = fixture();
  try {
    await seedCompletedTask(f, 'T-1');
    const r = await runAuditorCommand({
      argv: ['run', '--db', f.dbPath, '--repo', f.repoDir],
      dbPath: wrong.dbPath,
      repoDir: wrong.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.equal(r.code, 0);
    assert.match(r.out, /T-1/);
  } finally {
    f.log.close();
    f.cleanup();
    wrong.log.close();
    wrong.cleanup();
  }
});

test('invalid --rate -> validation error, never runs', async () => {
  const f = fixture();
  try {
    const r = await runAuditorCommand({
      argv: ['run', '--rate', 'abc'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /rate/i);
  } finally {
    f.log.close();
    f.cleanup();
  }
});

test('a genuine non_repro exits non-zero (signal for automation/cron)', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repoDir, 'gate-ladder.json'), JSON.stringify({ t1: { fullTests: 'false' } }));
    git(f.repoDir, 'add', '-A');
    git(f.repoDir, 'commit', '-q', '-m', 'flip to a failing check');
    const mergeCommit = git(f.repoDir, 'rev-parse', 'main').trim();
    const reportIntegrity = createReportIntegrity({
      evidence: f.evidence,
      authenticator: openEvidenceAuthenticator({
        runStateDir: f.root,
        runId: 'RUN-1',
        recovering: false,
        worktreeDirs: [f.repoDir],
      }),
    });
    const fabricated = reportIntegrity.signGateReport({
      tier: 'T1',
      pass: true,
      gateConfigHash: 'x',
      commitHash: mergeCommit,
      worktreeHash: git(f.repoDir, 'rev-parse', `${mergeCommit}^{tree}`).trim(),
      envHash: 'x',
      checks: [{ name: 'fullTests', pass: true, evidenceRef: f.evidence.put('stale green output') }],
      scopeNote: 'x',
    }, { runId: 'RUN-1', taskId: 'T-1' });
    f.log.append({
      runId: 'RUN-1',
      taskId: 'T-1',
      type: 'GATE_RESULT',
      payload: { ...fabricated } as unknown as Record<string, unknown>,
    });
    f.log.append({ runId: 'RUN-1', taskId: 'T-1', type: 'AUDIT_RESULT', payload: { sampled: false, mergeCommit } });
    f.log.append({ runId: 'RUN-1', taskId: 'T-1', type: 'TASK_STATE', payload: { state: 'COMPLETED' } });

    const r = await runAuditorCommand({
      argv: ['run'],
      dbPath: f.dbPath,
      repoDir: f.repoDir,
      gateConfigRelPath: 'gate-ladder.json',
      defaultRate: 100,
      now,
    });
    assert.equal(r.code, 2);
    assert.match(r.out, /non_repro/);
  } finally {
    f.log.close();
    f.cleanup();
  }
});
