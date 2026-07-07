// Deterministic executor (spec §6.1, REQ-1/2/6). Exactly-once semantics:
// snapshot-before-intent (git commit on the task worktree) -> ACTION_INTENT
// {snapshotRef, action} -> apply -> ACTION_APPLIED{resultHash}. Recovery is
// rollback-then-rerun, which is sound even for non-idempotent RUN_COMMAND.
// Duplicate actionIds skip idempotently. Out-of-policy proposals become
// structured rejections — never a crash, never a silent drop.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { PathPolicy } from './path-policy.ts';
import type { SandboxWrap } from '../security/sandbox.ts';
import type { Action, ActionRejection, Clock, Role } from '../types.ts';

export type ExecuteOutcome =
  | {
      status: 'applied';
      actionId: string;
      resultHash: string;
      outputRef?: string;
      exitCode?: number;
      /** True when the command ran inside the deny-network sandbox (egress denied by construction). */
      egressBlocked?: boolean;
    }
  | { status: 'skipped_duplicate'; actionId: string }
  | { status: 'rejected'; rejection: ActionRejection };

/** Deterministic failure injection for the crash-recovery scenarios (DoD#6). */
export interface Failpoints {
  crashAfterIntent?: boolean;
  crashAfterApply?: boolean;
}

export class CrashInjected extends Error {
  constructor(point: string) {
    super(`crash injected: ${point}`);
  }
}

export interface Executor {
  execute(action: Action, role: Role): Promise<ExecuteOutcome>;
}

export interface ExecutorOptions {
  worktreeDir: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  policy: PathPolicy;
  sandbox: SandboxWrap;
  clock: Clock;
  failpoints?: Failpoints;
  /**
   * Governed dependency-install policy (REQ-11.2). Absent = no `allowlist:*` grant
   * is authorized (every RUN_COMMAND stays `network:'none'` hard-deny, INV-14). The
   * composition root parses `.ai/policies/security-plane.json` and passes it.
   */
  depPolicy?: DepInstallPolicy;
}

/**
 * Package-install grant policy (REQ-11.2). `commandPattern` is a RegExp source the
 * command must match (a frozen-lockfile + `--ignore-scripts` install); `lockfilePatterns`
 * is the SAME governance-pinned manifest/lockfile list the auto-merge risk floor uses
 * (AZ-17) — a matching lockfile must exist in the worktree when `requireLockfile`.
 */
export interface DepInstallPolicy {
  commandPattern: string;
  requireLockfile: boolean;
  lockfilePatterns: string[];
}

/** A lockfile named by the policy list exists at the worktree root (frozen installs read root). */
function hasLockfile(worktreeDir: string, patterns: string[]): boolean {
  return patterns.some((pat) => existsSync(join(worktreeDir, pat)));
}

/**
 * Pure REQ-11.2 gate: the command matches the frozen-lockfile install pattern AND
 * (when required) a lockfile is present. Never runs anything — the executor calls
 * this before granting the network-permitting sandbox to a single command.
 */
export function packageInstallAllowed(
  cmd: string,
  worktreeDir: string,
  policy: DepInstallPolicy,
): { ok: true } | { ok: false; reason: string } {
  let re: RegExp;
  try {
    re = new RegExp(policy.commandPattern);
  } catch {
    return { ok: false, reason: 'security-plane commandPattern is not a valid RegExp' };
  }
  if (!re.test(cmd)) {
    return { ok: false, reason: 'command does not match the frozen-lockfile install pattern' };
  }
  if (policy.requireLockfile && !hasLockfile(worktreeDir, policy.lockfilePatterns)) {
    return { ok: false, reason: 'no lockfile present in the worktree' };
  }
  return { ok: true };
}

export interface RecoveryReport {
  action: 'none' | 'replayed_intent' | 'rolled_back';
  detail: string;
}

// Deterministic, secret-free environment for target commands (INV-14 spirit).
const COMMAND_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Commit the entire worktree state and return the commit hash (snapshot ref). */
function snapshotWorktree(worktreeDir: string, label: string): string {
  git(worktreeDir, 'add', '-A');
  git(worktreeDir, 'commit', '-q', '--allow-empty', '-m', `core-snapshot: ${label}`);
  return git(worktreeDir, 'rev-parse', 'HEAD').trim();
}

/** Content hash of the full worktree (tracked + untracked) after an action. */
function worktreeHash(worktreeDir: string): string {
  git(worktreeDir, 'add', '-A');
  return git(worktreeDir, 'write-tree').trim();
}

function rollbackTo(worktreeDir: string, snapshotRef: string): void {
  git(worktreeDir, 'reset', '-q', '--hard', snapshotRef);
  git(worktreeDir, 'clean', '-qfd');
}

function validate(action: Action): string | null {
  if (typeof action.actionId !== 'string' || action.actionId.length === 0) {
    return 'actionId must be a non-empty string';
  }
  switch (action.type) {
    case 'WRITE_FILE':
      if (!action.path || !action.contentRef) return 'WRITE_FILE requires path and contentRef';
      return null;
    case 'APPLY_PATCH':
      if (!action.diffRef) return 'APPLY_PATCH requires diffRef';
      return null;
    case 'RUN_COMMAND':
      if (!action.cmd) return 'RUN_COMMAND requires cmd';
      if (action.network !== 'none' && !action.network.startsWith('allowlist:')) {
        return 'network must be "none" or "allowlist:<name>"';
      }
      return null;
    case 'READ_FILE':
      if (!action.path) return 'READ_FILE requires path';
      return null;
    case 'REQUEST_TOOL':
      if (!action.name) return 'REQUEST_TOOL requires name';
      return null;
    default:
      return 'unknown action type';
  }
}

/** Resolve a worktree-relative path and enforce realpath containment (symlink escapes). */
function resolveContained(worktreeDir: string, relPath: string): string | null {
  const abs = resolve(worktreeDir, relPath);
  const rootReal = realpathSync(worktreeDir);
  if (!abs.startsWith(rootReal + '/') && abs !== rootReal) {
    // resolve() escaped lexically (e.g. ../)
    if (!abs.startsWith(resolve(worktreeDir) + '/')) return null;
  }
  // Walk to the nearest existing ancestor and verify ITS realpath stays inside.
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (real !== rootReal && !real.startsWith(rootReal + '/')) return null;
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return abs;
}

export function createExecutor(opts: ExecutorOptions): Executor {
  return {
    async execute(action, role) {
      return executeOnce(opts, action, role);
    },
  };
}

function reject(
  opts: ExecutorOptions,
  actionId: string,
  reason: ActionRejection['reason'],
  detail: string,
): ExecuteOutcome {
  const rejection: ActionRejection = { actionId, reason, detail };
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'ACTION_REJECTED',
    payload: { ...rejection },
  });
  return { status: 'rejected', rejection };
}

function alreadyApplied(opts: ExecutorOptions, actionId: string): boolean {
  return opts.log
    .all({ taskId: opts.taskId, type: 'ACTION_APPLIED' })
    .some((e) => e.payload['actionId'] === actionId && e.payload['duplicate'] !== true);
}

async function executeOnce(
  opts: ExecutorOptions,
  action: Action,
  role: Role,
): Promise<ExecuteOutcome> {
  const invalid = validate(action);
  if (invalid !== null) {
    return reject(opts, action.actionId ?? '(missing)', 'schema_violation', invalid);
  }

  if (alreadyApplied(opts, action.actionId)) {
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_APPLIED',
      payload: { actionId: action.actionId, duplicate: true },
    });
    return { status: 'skipped_duplicate', actionId: action.actionId };
  }

  // Policy gates before any side effect.
  if (action.type === 'WRITE_FILE') {
    const decision = opts.policy.checkWrite(role, action.path);
    if (!decision.allowed) {
      return reject(
        opts,
        action.actionId,
        decision.reason as ActionRejection['reason'],
        `write to ${action.path} denied for role ${role}`,
      );
    }
    if (resolveContained(opts.worktreeDir, action.path) === null) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `path escapes worktree: ${action.path}`);
    }
  }
  if (action.type === 'READ_FILE') {
    const decision = opts.policy.checkRead(role, action.path);
    if (!decision.allowed) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `read of ${action.path} denied`);
    }
  }
  if (action.type === 'APPLY_PATCH') {
    return reject(
      opts,
      action.actionId,
      'unsupported_action_phase0',
      'APPLY_PATCH lands with the repair loop phase; propose WRITE_FILE per file',
    );
  }
  if (action.type === 'REQUEST_TOOL') {
    return reject(
      opts,
      action.actionId,
      'unsupported_action_phase0',
      `no tool handlers enabled in this phase (requested: ${action.name})`,
    );
  }
  if (action.type === 'RUN_COMMAND') {
    // Egress is default-deny (INV-14, REQ-11.3). The ONLY authorized grant is a
    // governed, frozen-lockfile package install; every other network name is denied.
    if (action.network !== 'none') {
      if (action.network !== 'allowlist:package_install') {
        return reject(
          opts,
          action.actionId,
          'unsupported_action_phase0',
          `network grant ${action.network} is not enabled; only "package_install" is governed`,
        );
      }
      // The grant NEVER executes on an unenforced host — fail closed (REQ-11.7).
      if (opts.sandbox.kind === 'unavailable') {
        return reject(opts, action.actionId, 'sandbox_unavailable', opts.sandbox.reason);
      }
      if (opts.depPolicy === undefined) {
        return reject(opts, action.actionId, 'network_policy_denied', 'no dependency-install policy configured');
      }
      const gate = packageInstallAllowed(action.cmd, opts.worktreeDir, opts.depPolicy);
      if (!gate.ok) {
        return reject(opts, action.actionId, 'network_policy_denied', gate.reason);
      }
    }
    if (opts.sandbox.kind === 'unavailable') {
      return reject(opts, action.actionId, 'sandbox_unavailable', opts.sandbox.reason);
    }
    if (action.cwd !== undefined && resolveContained(opts.worktreeDir, action.cwd) === null) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `cwd escapes worktree: ${action.cwd}`);
    }
  }

  // Non-mutating actions need no snapshot/INTENT (REQ-6.1).
  if (action.type === 'READ_FILE') {
    const abs = resolveContained(opts.worktreeDir, action.path);
    if (abs === null) {
      return reject(opts, action.actionId, 'path_outside_allowlist', `path escapes worktree: ${action.path}`);
    }
    const { readFileSync } = await import('node:fs');
    let content: Uint8Array;
    try {
      content = readFileSync(abs);
    } catch {
      return reject(opts, action.actionId, 'schema_violation', `file not found: ${action.path}`);
    }
    const outputRef = opts.evidence.put(content);
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_APPLIED',
      payload: { actionId: action.actionId, resultHash: outputRef, outputRef, duplicate: false },
    });
    return { status: 'applied', actionId: action.actionId, resultHash: outputRef, outputRef };
  }

  // Mutating path: snapshot -> INTENT -> apply -> APPLIED.
  const snapshotRef = snapshotWorktree(opts.worktreeDir, action.actionId);
  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'ACTION_INTENT',
    payload: { actionId: action.actionId, snapshotRef, action: { ...action } },
  });

  if (opts.failpoints?.crashAfterIntent) throw new CrashInjected('after_intent');

  const applied = performApply(opts, action);

  if (opts.failpoints?.crashAfterApply) throw new CrashInjected('after_apply');

  opts.log.append({
    runId: opts.runId,
    taskId: opts.taskId,
    type: 'ACTION_APPLIED',
    payload: { actionId: action.actionId, duplicate: false, ...applied },
  });
  return { status: 'applied', actionId: action.actionId, ...applied };
}

function performApply(
  opts: ExecutorOptions,
  action: Extract<Action, { type: 'WRITE_FILE' | 'RUN_COMMAND' }>,
): { resultHash: string; outputRef?: string; exitCode?: number; egressBlocked?: boolean } {
  if (action.type === 'WRITE_FILE') {
    const abs = resolveContained(opts.worktreeDir, action.path);
    if (abs === null) throw new Error(`containment failed post-policy: ${action.path}`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, opts.evidence.get(action.contentRef));
    return { resultHash: worktreeHash(opts.worktreeDir) };
  }

  // RUN_COMMAND under the sandbox (validated available + policy-gated upstream). A
  // governed package_install runs with egress permitted for that single command
  // (REQ-11.2); everything else keeps the deny-network profile (REQ-11.3).
  if (opts.sandbox.kind !== 'available') throw new Error('sandbox availability changed mid-flight');
  const allowNetwork = action.network === 'allowlist:package_install';
  const { cmd, args } = opts.sandbox.wrap(action.cmd, opts.worktreeDir, allowNetwork);
  const cwd =
    action.cwd === undefined
      ? opts.worktreeDir
      : (resolveContained(opts.worktreeDir, action.cwd) as string);
  // Policy-pinned per-probe bound when set (REQ-5.8); otherwise the default ceiling.
  const timeout = action.timeoutMs !== undefined ? action.timeoutMs : 120_000;
  const res = spawnSync(cmd, args, { cwd, env: COMMAND_ENV, encoding: 'utf8', timeout });
  const output = `exit:${res.status}\n--- stdout ---\n${res.stdout ?? ''}\n--- stderr ---\n${res.stderr ?? ''}`;
  const outputRef = opts.evidence.put(output);
  return {
    resultHash: worktreeHash(opts.worktreeDir),
    outputRef,
    exitCode: res.status ?? -1,
    egressBlocked: !allowNetwork,
  };
}

/** Replay-based crash recovery (spec §6.2, REQ-6.2/6.4). */
export async function recoverWorktree(
  opts: Omit<ExecutorOptions, 'failpoints'>,
): Promise<RecoveryReport> {
  const intents = opts.log.all({ taskId: opts.taskId, type: 'ACTION_INTENT' });
  const appliedIds = new Set(
    opts.log
      .all({ taskId: opts.taskId, type: 'ACTION_APPLIED' })
      .filter((e) => e.payload['duplicate'] !== true)
      .map((e) => e.payload['actionId']),
  );

  const lastIntent = intents[intents.length - 1];
  if (lastIntent !== undefined && !appliedIds.has(lastIntent.payload['actionId'])) {
    // Crash between INTENT and APPLIED: rollback-then-rerun (exactly-once).
    const snapshotRef = String(lastIntent.payload['snapshotRef']);
    const action = lastIntent.payload['action'] as Extract<
      Action,
      { type: 'WRITE_FILE' | 'RUN_COMMAND' }
    >;
    rollbackTo(opts.worktreeDir, snapshotRef);
    const applied = performApply(opts, action);
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'ACTION_APPLIED',
      payload: { actionId: action.actionId, duplicate: false, recovered: true, ...applied },
    });
    return {
      action: 'replayed_intent',
      detail: `rolled back to ${snapshotRef} and re-ran ${action.actionId}`,
    };
  }

  // No dangling intent: verify the worktree still matches the last applied state (REQ-6.4).
  const applieds = opts.log
    .all({ taskId: opts.taskId, type: 'ACTION_APPLIED' })
    .filter((e) => e.payload['duplicate'] !== true && typeof e.payload['resultHash'] === 'string');
  const lastApplied = applieds[applieds.length - 1];
  if (lastApplied !== undefined) {
    const expected = String(lastApplied.payload['resultHash']);
    if (expected.startsWith('blob://') === false && worktreeHash(opts.worktreeDir) !== expected) {
      const matchingIntent = intents.find(
        (e) => e.payload['actionId'] === lastApplied.payload['actionId'],
      );
      if (matchingIntent !== undefined) {
        rollbackTo(opts.worktreeDir, String(matchingIntent.payload['snapshotRef']));
        return {
          action: 'rolled_back',
          detail: 'worktree hash disagreed with last ACTION_APPLIED; rolled back to its snapshot',
        };
      }
    }
  }
  return { action: 'none', detail: 'log and worktree consistent' };
}
