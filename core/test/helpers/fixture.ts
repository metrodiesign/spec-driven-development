// Synthetic target-repo fixture for the fault-injection suite (design: "Golden
// harness"). Scenarios run against THIS repo, never against the platform repo.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { Clock, IdSource } from '../../src/types.ts';
import type { TaskLeaseSession } from '../../src/state/lease.ts';
import type { SandboxWrap } from '../../src/security/sandbox.ts';
import { openEvidenceAuthenticator } from '../../src/evidence/auth.ts';
import type { EvidenceStore } from '../../src/evidence/store.ts';
import { createReportIntegrity, type ReportIntegrity } from '../../src/gates/report-integrity.ts';

/** Test-only backend for logic suites; dedicated kernel-enforcement tests opt in separately. */
export const PASSTHROUGH_TEST_SANDBOX: SandboxWrap = {
  kind: 'available',
  networkPolicyHash: 'test-passthrough',
  wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
};

export interface Fixture {
  root: string;
  /** The synthetic target repo (its own git history). */
  worktree: string;
  dbPath: string;
  evidenceDir: string;
  gateConfigPath: string;
  cleanup(): void;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Manifest format: `<sha256>  <path relative to golden dir>` per line, sorted. */
export function manifestFor(goldenDir: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name !== '_MANIFEST.sha256') {
        lines.push(`${sha256Hex(readFileSync(p))}  ${relative(goldenDir, p)}`);
      }
    }
  };
  walk(goldenDir);
  return lines.sort().join('\n') + '\n';
}

const FIXTURE_GATE_LADDER = {
  t0: { lint: 'true', typecheck: 'true', targetedTests: 'fallback:full_unit' },
  t1: { fullTests: 'sh run-tests.sh', convention: 'builtin', golden: 'builtin' },
  t2: { status: 'not_enabled_phase0' },
  t3: { status: 'not_enabled_phase0' },
};

export function makeFixture(opts?: { fullTests?: string; t0Lint?: string }): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'fault-injection-'));
  const worktree = join(root, 'target');
  mkdirSync(worktree, { recursive: true });

  git(worktree, 'init', '-q', '-b', 'main');
  git(worktree, 'config', 'user.email', 'fixture@example.invalid');
  git(worktree, 'config', 'user.name', 'fixture');

  mkdirSync(join(worktree, 'src'), { recursive: true });
  mkdirSync(join(worktree, 'test', 'ai-generated'), { recursive: true });
  mkdirSync(join(worktree, 'test', 'golden'), { recursive: true });

  // Target "code": tests pass iff src/impl.txt contains the word `correct`.
  writeFileSync(join(worktree, 'src', 'impl.txt'), 'wrong\n');
  writeFileSync(join(worktree, 'test', 'ai-generated', '.gitkeep'), '');
  writeFileSync(join(worktree, 'test', 'golden', 'expected.txt'), 'golden truth\n');
  writeFileSync(
    join(worktree, 'test', 'golden', '_MANIFEST.sha256'),
    manifestFor(join(worktree, 'test', 'golden')),
  );
  writeFileSync(join(worktree, 'run-tests.sh'), '#!/bin/sh\ngrep -q correct src/impl.txt\n');

  const gateConfigPath = join(worktree, 'gate-ladder.json');
  const ladder = structuredClone(FIXTURE_GATE_LADDER);
  if (opts?.fullTests !== undefined) ladder.t1.fullTests = opts.fullTests;
  if (opts?.t0Lint !== undefined) ladder.t0.lint = opts.t0Lint;
  writeFileSync(gateConfigPath, JSON.stringify(ladder, null, 2) + '\n');

  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'fixture: initial target repo');

  const evidenceDir = join(root, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  return {
    root,
    worktree,
    dbPath: join(root, 'events.db'),
    evidenceDir,
    gateConfigPath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Deterministic, manually-advanced clock — scenarios control time explicitly. */
export function makeClock(startMs = 1_000_000): Clock & { tick(ms: number): void } {
  let t = startMs;
  return {
    now: () => t,
    tick: (ms: number) => {
      t += ms;
    },
  };
}

export function makeIds(): IdSource {
  let n = 0;
  return { next: (prefix: string) => `${prefix}-${++n}` };
}

/** Explicit lease capability for unit harnesses that do not need SQLite contention. */
export function makeTestLeaseSession(taskId = 'T-1'): TaskLeaseSession {
  const claim = { taskId, ownerId: 'test-owner', fencingToken: 1, leaseUntil: Number.MAX_SAFE_INTEGER };
  let active = true;
  return {
    claim,
    heartbeat: async () => active,
    verifyOwnership: () => active,
    reacquireAfterPause: async () => active,
    startHeartbeat: () => {},
    stopHeartbeat: () => {},
    release: () => { active = false; },
    ownershipLost: false,
  };
}

/** Test composition for the per-run Ed25519 trust root (REQ-4). */
export function makeReportIntegrity(
  fix: Fixture,
  evidence: EvidenceStore,
  runId = 'RUN-1',
): ReportIntegrity {
  const authenticator = openEvidenceAuthenticator({
    runStateDir: fix.root,
    runId,
    recovering: existsSync(join(fix.root, 'run-metadata.json')),
    worktreeDirs: [fix.worktree],
  });
  return createReportIntegrity({ evidence, authenticator });
}

/**
 * A flaky test script: fails on first run, passes afterwards (marker file).
 * Every execution prints `GATE_RUN` and appends to a disposable `.runs` marker
 * so evidence can prove HOW MANY times the gate ran without mutating the source tree.
 */
export function installFlakyTests(fix: Fixture): void {
  writeFileSync(
    join(fix.worktree, 'run-tests.sh'),
    '#!/bin/sh\necho GATE_RUN\necho x >> .runs\nif [ -f .flaky-ran ]; then exit 0; else touch .flaky-ran; exit 1; fi\n',
  );
  git(fix.worktree, 'add', '-A');
  git(fix.worktree, 'commit', '-q', '-m', 'fixture: flaky tests');
}

/** A deterministically failing test script — the control for flaky detection. */
export function installAlwaysFailTests(fix: Fixture): void {
  writeFileSync(
    join(fix.worktree, 'run-tests.sh'),
    '#!/bin/sh\necho GATE_RUN\necho x >> .runs\nexit 1\n',
  );
  git(fix.worktree, 'add', '-A');
  git(fix.worktree, 'commit', '-q', '-m', 'fixture: always-fail tests');
}
