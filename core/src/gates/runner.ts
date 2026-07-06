// Gate ladder (spec §6.4, REQ-8/9). Core runs every command itself and captures
// output straight from the child process into the evidence store — reports are
// core-produced, never agent-reported. T2/T3 report not_enabled explicitly.
// Flaky handling (REQ-8.5): one retry; fail-then-pass = flaky_suspect, flagged
// for a human, NOT passed and NOT auto-quarantined (INV-16).

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { verifyGoldenManifest } from './golden.ts';
import type { EventLog } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { Clock, GateCheck, GateReport, GateTier } from '../types.ts';

export interface GateRunner {
  run(tier: GateTier): Promise<GateReport>;
}

export interface GateRunnerOptions {
  worktreeDir: string;
  /** Path to the ladder policy file; its raw bytes are hashed into every report. */
  configPath: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  clock: Clock;
}

interface LadderConfig {
  t0?: { lint?: string; typecheck?: string; targetedTests?: string };
  t1?: { fullTests?: string; convention?: string; golden?: string };
  t2?: { status?: string };
  t3?: { status?: string };
}

const SCOPE_NOTE =
  'golden check detects golden-file tampering via manifest hashes only (REQ-9.3); ' +
  'vacuous generated tests are addressed by the RED-check in a later phase';

// Deterministic, secret-free environment for gate commands (REQ open question:
// envHash characterizes platform + runtime only — never secrets).
const COMMAND_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Test-file convention gate (INV-16 prohibited list): no `.only(` / `.skip(`. */
function conventionCheck(worktreeDir: string): { pass: boolean; detail: string } {
  const offenders: string[] = [];
  const testsDir = join(worktreeDir, 'test');
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const body = readFileSync(p, 'utf8');
        if (body.includes('.only(') || body.includes('.skip(')) offenders.push(p);
      }
    }
  };
  walk(testsDir);
  return offenders.length === 0
    ? { pass: true, detail: 'no .only/.skip in test files' }
    : { pass: false, detail: `prohibited .only/.skip in: ${offenders.join(', ')}` };
}

export function createGateRunner(opts: GateRunnerOptions): GateRunner {
  const configBytes = readFileSync(opts.configPath);
  const gateConfigHash = sha256Hex(configBytes);
  const config = JSON.parse(configBytes.toString('utf8')) as LadderConfig;

  function runCommandCheck(name: string, cmd: string): GateCheck {
    const runOnce = () =>
      spawnSync('/bin/sh', ['-c', cmd], {
        cwd: opts.worktreeDir,
        env: COMMAND_ENV,
        encoding: 'utf8',
        timeout: 300_000,
      });
    const first = runOnce();
    if (first.status === 0) {
      const ref = opts.evidence.put(`exit:0\n${first.stdout ?? ''}${first.stderr ?? ''}`);
      return { name, pass: true, evidenceRef: ref };
    }
    // One retry (REQ-8.5). Fail-then-pass is a flake suspect — flagged, not passed.
    const second = runOnce();
    const ref = opts.evidence.put(
      `attempt1 exit:${first.status}\n${first.stdout ?? ''}${first.stderr ?? ''}\n` +
        `attempt2 exit:${second.status}\n${second.stdout ?? ''}${second.stderr ?? ''}`,
    );
    if (second.status === 0) {
      return {
        name,
        pass: false,
        flakySuspect: true,
        evidenceRef: ref,
        detail: 'fail-then-pass on retry: flaky_suspect, needs human review (never auto-quarantined)',
      };
    }
    return { name, pass: false, evidenceRef: ref, detail: `exit ${second.status}` };
  }

  function resolveTargetedTests(): string | undefined {
    const t0 = config.t0?.targetedTests;
    if (t0 === undefined) return undefined;
    // §6.4 T0: targeted-test selection starts as fallback = full unit suite.
    if (t0.startsWith('fallback:full_unit')) return config.t1?.fullTests;
    return t0;
  }

  async function runTier(tier: GateTier): Promise<GateReport> {
    const commitHash = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: opts.worktreeDir,
      encoding: 'utf8',
    }).trim();
    const envHash = sha256Hex(
      JSON.stringify({ platform: process.platform, node: process.version }),
    );
    const base = { tier, gateConfigHash, commitHash, envHash, scopeNote: SCOPE_NOTE };

    if (tier === 'T2' || tier === 'T3') {
      // Explicit stub — never a silent pass (REQ-8.4).
      return { ...base, pass: 'not_enabled', checks: [] };
    }

    const checks: GateCheck[] = [];
    if (tier === 'T0') {
      const t0 = config.t0 ?? {};
      if (t0.lint !== undefined) checks.push(runCommandCheck('lint', t0.lint));
      if (t0.typecheck !== undefined) checks.push(runCommandCheck('typecheck', t0.typecheck));
      const targeted = resolveTargetedTests();
      if (targeted !== undefined) checks.push(runCommandCheck('targetedTests', targeted));
    } else {
      const t1 = config.t1 ?? {};
      if (t1.fullTests !== undefined) checks.push(runCommandCheck('fullTests', t1.fullTests));
      if (t1.convention === 'builtin') {
        const conv = conventionCheck(opts.worktreeDir);
        checks.push({
          name: 'convention',
          pass: conv.pass,
          evidenceRef: opts.evidence.put(conv.detail),
          detail: conv.detail,
        });
      }
      if (t1.golden === 'builtin') {
        const verdict = verifyGoldenManifest(opts.worktreeDir);
        checks.push({
          name: 'golden',
          pass: verdict.ok,
          evidenceRef: opts.evidence.put(JSON.stringify(verdict)),
          ...(verdict.ok ? {} : { detail: `${verdict.reason}: ${verdict.detail}` }),
        });
      }
    }

    const report: GateReport = {
      ...base,
      pass: checks.every((c) => c.pass),
      checks,
    };
    opts.log.append({
      runId: opts.runId,
      taskId: opts.taskId,
      type: 'GATE_RESULT',
      payload: { ...report } as unknown as Record<string, unknown>,
    });
    return report;
  }

  return { run: runTier };
}
