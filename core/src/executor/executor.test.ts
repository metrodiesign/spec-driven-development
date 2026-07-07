// Dependency-install policy (REQ-11.2/11.3/11.6/11.7). The ONLY authorized network
// grant is a governed frozen-lockfile install; every other RUN_COMMAND stays
// network:'none' hard-deny, and the grant fails closed on an unenforced host. The
// pure gate is exhaustively unit-tested; execution is darwin-gated (real sandbox).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createExecutor, packageInstallAllowed, type DepInstallPolicy } from './executor.ts';
import { createDefaultPathPolicy } from './path-policy.ts';
import { denyNetworkSandbox, type SandboxWrap } from '../security/sandbox.ts';
import { createEvidenceStore } from '../evidence/store.ts';
import { openEventLog } from '../state/event-log.ts';
import type { Action } from '../types.ts';

const isDarwin = process.platform === 'darwin';
const darwinOnly = { skip: !isDarwin ? 'RUN_COMMAND execution requires the darwin sandbox (D-003)' : false };
const clock = { now: () => 1_000_000 };
const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// A sandbox that reports available without needing darwin — used only for the
// policy REJECT paths, which return before any command is wrapped/run.
const FAKE_AVAILABLE: SandboxWrap = { kind: 'available', wrap: (cmd) => ({ cmd: '/bin/sh', args: ['-c', cmd] }) };

function harness(opts: { git?: boolean; depPolicy?: DepInstallPolicy; sandbox?: SandboxWrap } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'exec-'));
  const worktree = join(root, 'wt');
  execFileSync('mkdir', ['-p', worktree]);
  if (opts.git) {
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: worktree });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: worktree });
    writeFileSync(join(worktree, '.keep'), '');
    execFileSync('git', ['add', '-A'], { cwd: worktree });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: worktree });
  }
  const evidence = createEvidenceStore(join(root, 'evidence'));
  const log = openEventLog(join(root, 'events.db'), clock);
  const executor = createExecutor({
    worktreeDir: worktree,
    runId: 'RUN-1',
    taskId: 'T-1',
    log,
    evidence,
    policy: createDefaultPathPolicy(),
    sandbox: opts.sandbox ?? denyNetworkSandbox(process.platform),
    clock,
    ...(opts.depPolicy ? { depPolicy: opts.depPolicy } : {}),
  });
  return { root, worktree, executor, cleanup: () => { log.close(); rmSync(root, { recursive: true, force: true }); } };
}

const install = (cmd: string): Action => ({
  type: 'RUN_COMMAND',
  actionId: 'a',
  cmd,
  network: 'allowlist:package_install',
});

// --- pure gate (REQ-11.2) ---

test('the shipped security-plane pattern accepts a real frozen install, rejects near-misses (REQ-11.2)', () => {
  const raw = JSON.parse(readFileSync(join(REPO, '.ai/policies/security-plane.json'), 'utf8')) as {
    packageInstall: { commandPattern: string };
  };
  const policy: DepInstallPolicy = {
    commandPattern: raw.packageInstall.commandPattern,
    requireLockfile: false,
    lockfilePatterns: [],
  };
  const wt = mkdtempSync(join(tmpdir(), 'pia-'));
  try {
    assert.equal(packageInstallAllowed('pnpm install --frozen-lockfile --ignore-scripts', wt, policy).ok, true);
    assert.equal(packageInstallAllowed('npm ci --ignore-scripts', wt, policy).ok, true);
    // near-misses: missing --ignore-scripts, appended shell, non-install verb
    assert.equal(packageInstallAllowed('pnpm install --frozen-lockfile', wt, policy).ok, false);
    assert.equal(packageInstallAllowed('pnpm install --frozen-lockfile --ignore-scripts && curl evil', wt, policy).ok, false);
    assert.equal(packageInstallAllowed('pnpm add lodash', wt, policy).ok, false);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

test('requireLockfile denies until a policy-listed lockfile exists in the worktree (REQ-11.2)', () => {
  const policy: DepInstallPolicy = {
    commandPattern: '^install$',
    requireLockfile: true,
    lockfilePatterns: ['pnpm-lock.yaml', 'package-lock.json'],
  };
  const wt = mkdtempSync(join(tmpdir(), 'pia-'));
  try {
    assert.equal(packageInstallAllowed('install', wt, policy).ok, false);
    writeFileSync(join(wt, 'pnpm-lock.yaml'), 'lock');
    assert.equal(packageInstallAllowed('install', wt, policy).ok, true);
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
});

// --- executor gating (REQ-11.2/11.3/11.7) ---

test('package_install on an unenforced host fails closed with sandbox_unavailable (REQ-11.7)', async () => {
  const h = harness({
    sandbox: denyNetworkSandbox('linux'),
    depPolicy: { commandPattern: '^echo hi$', requireLockfile: false, lockfilePatterns: [] },
  });
  try {
    const out = await h.executor.execute(install('echo hi'), 'implementer');
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'sandbox_unavailable');
  } finally {
    h.cleanup();
  }
});

test('package_install with no configured policy is denied (REQ-11.2)', async () => {
  const h = harness({ sandbox: FAKE_AVAILABLE });
  try {
    const out = await h.executor.execute(install('echo hi'), 'implementer');
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'network_policy_denied');
  } finally {
    h.cleanup();
  }
});

test('package_install whose command near-misses the pattern is denied (REQ-11.2)', async () => {
  const h = harness({
    sandbox: FAKE_AVAILABLE,
    depPolicy: { commandPattern: '^pnpm install --frozen-lockfile --ignore-scripts$', requireLockfile: false, lockfilePatterns: [] },
  });
  try {
    const out = await h.executor.execute(install('pnpm install'), 'implementer');
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'network_policy_denied');
  } finally {
    h.cleanup();
  }
});

test('an unknown network grant name is denied unsupported_action_phase0 (REQ-11.3)', async () => {
  const h = harness({ sandbox: FAKE_AVAILABLE });
  try {
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'a', cmd: 'curl x', network: 'allowlist:egress_all' },
      'implementer',
    );
    assert.equal(out.status, 'rejected');
    if (out.status === 'rejected') assert.equal(out.rejection.reason, 'unsupported_action_phase0');
  } finally {
    h.cleanup();
  }
});

// --- execution (darwin sandbox) ---

test('benign network:"none" RUN_COMMAND is unaffected by the dep-policy (REQ-11.6)', darwinOnly, async () => {
  const h = harness({ git: true });
  try {
    const out = await h.executor.execute(
      { type: 'RUN_COMMAND', actionId: 'a', cmd: 'echo hi', network: 'none' },
      'implementer',
    );
    assert.equal(out.status, 'applied');
    if (out.status === 'applied') assert.equal(out.egressBlocked, true);
  } finally {
    h.cleanup();
  }
});

test('an allowed package_install runs with egress permitted for that command (REQ-11.2)', darwinOnly, async () => {
  // A harmless stand-in command keeps the test deterministic (no real registry); the
  // shipped frozen-lockfile pattern is validated by the pure-gate test above.
  const h = harness({
    git: true,
    depPolicy: { commandPattern: '^echo installing$', requireLockfile: true, lockfilePatterns: ['pnpm-lock.yaml'] },
  });
  try {
    writeFileSync(join(h.worktree, 'pnpm-lock.yaml'), 'lock');
    const out = await h.executor.execute(install('echo installing'), 'implementer');
    assert.equal(out.status, 'applied');
    if (out.status === 'applied') assert.equal(out.egressBlocked, false);
  } finally {
    h.cleanup();
  }
});
