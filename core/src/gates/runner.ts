// Gate ladder (spec §6.4, REQ-8/9). Core runs every command itself and captures
// output straight from the child process into the evidence store — reports are
// core-produced, never agent-reported. T3 always reports not_enabled; T2 does
// too UNTIL the ladder file carries a real config (REQ-12.1/12.2) — enabling it
// is a governance-approved event by construction (the file hash changes).
// Flaky handling (REQ-8.5): one retry; fail-then-pass = flaky_suspect, flagged
// for a human, NOT passed and NOT auto-quarantined (INV-16).

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freezeWorkingTree, readHeadCommit, type FrozenTree } from './frozen-tree.ts';
import { verifyGoldenManifest } from './golden.ts';
import { LeaseFenceError, type EventLog, type FencedEventClaim } from '../state/event-log.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import type { ReportIntegrity } from './report-integrity.ts';
import {
  createCoreCommandExecutor,
  type CoreCommandExecutor,
  type CoreCommandOutcome,
} from '../executor/command-executor.ts';
import { createDefaultPathPolicy } from '../executor/path-policy.ts';
import {
  createCommandRunner,
} from '../security/command-runner.ts';
import { denyNetworkSandbox, type SandboxWrap } from '../security/sandbox.ts';
import type { Clock, GateCheck, GateReport, GateTier } from '../types.ts';
import {
  checkConvention,
  DEFAULT_CONVENTION_POLICY,
  parseConventionPolicy,
  type ConventionPolicy,
} from './convention.ts';

export interface GateRunner {
  run(tier: GateTier): Promise<GateReport>;
  verify(report: GateReport): GateReport;
}

export interface GateRunnerOptions {
  worktreeDir: string;
  /** Path to the ladder policy file; its raw bytes are hashed into every report. */
  configPath: string;
  /** Versioned syntactic convention policy; bytes join gateConfigHash when supplied. */
  conventionPolicyPath?: string;
  runId: string;
  taskId: string;
  log: EventLog;
  evidence: EvidenceStore;
  reportIntegrity: ReportIntegrity;
  clock: Clock;
  /** Core-owned command orchestration seam; low-level spawn is not injectable here. */
  commandExecutor?: CoreCommandExecutor;
  /** Production default for the shared runner when commandRunner is not injected. */
  sandbox?: SandboxWrap;
  /** Current owner generation; gate reports are committed through an atomic fence. */
  fence?: () => FencedEventClaim;
}

interface LadderConfig {
  t0?: { lint?: string; typecheck?: string; targetedTests?: string };
  t1?: { fullTests?: string; convention?: string; golden?: string };
  t2?: { status?: string } | { build?: string; scopedE2e?: string; secretScan?: string; fullGolden?: 'builtin' };
  t3?: { status?: string };
}

const SCOPE_NOTE =
  'golden check detects golden-file tampering via manifest hashes only (REQ-9.3); ' +
  'frozen RED provenance protects observed test artifacts; syntactic convention matching makes no semantic-correctness claim (REQ-9)';
const FLAKY_RETRY_EXIT = 79;
const FLAKY_RETRY_MARKER = '__CORE_GATE_FAIL_THEN_PASS__';

function sha256Hex(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createGateRunner(opts: GateRunnerOptions): GateRunner {
  let configBytes: Uint8Array;
  let config: LadderConfig | null = null;
  let configError: string | null = null;
  try {
    configBytes = readFileSync(opts.configPath);
  } catch (error) {
    configBytes = new TextEncoder().encode('');
    configError = `gate configuration unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const gateConfigHash = sha256Hex(configBytes);
  let effectiveGateConfigHash = gateConfigHash;
  let conventionPolicy: ConventionPolicy | undefined = DEFAULT_CONVENTION_POLICY;
  let conventionPolicyError: string | undefined;
  if (opts.conventionPolicyPath !== undefined) {
    let conventionBytesForHash: Uint8Array | undefined;
    try {
      const policyBytes = readFileSync(opts.conventionPolicyPath);
      conventionBytesForHash = policyBytes;
      conventionPolicy = parseConventionPolicy(policyBytes);
      effectiveGateConfigHash = sha256Hex(
        Buffer.concat([configBytes, Buffer.from('\n--convention-policy-v1--\n'), policyBytes]),
      );
    } catch (error) {
      conventionPolicyError = `convention policy unavailable or malformed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      effectiveGateConfigHash = sha256Hex(
        Buffer.concat([
          configBytes,
          Buffer.from('\n--convention-policy-v1--\n'),
          conventionBytesForHash ?? Buffer.from(conventionPolicyError),
        ]),
      );
    }
  }
  if (configError === null) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(configBytes)) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        configError = 'malformed gate configuration: root must be an object';
      } else {
        config = parsed as LadderConfig;
      }
    } catch (error) {
      configError = `malformed gate configuration: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const sandbox = opts.sandbox ?? denyNetworkSandbox(process.platform);
  const commandExecutor =
    opts.commandExecutor ??
    createCoreCommandExecutor({
      evidence: opts.evidence,
      policy: createDefaultPathPolicy(),
      sandbox,
      commandRunner: createCommandRunner({ sandbox, evidence: opts.evidence }),
    });

  async function withDisposableTree<T>(
    frozen: FrozenTree,
    use: (workspaceRoot: string) => Promise<T>,
  ): Promise<T> {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'gate-check-'));
    try {
      await frozen.materialize(workspaceRoot);
      return await use(workspaceRoot);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  function failureDetail(result: CoreCommandOutcome): string {
    if (result.status === 'preflight_rejected' || result.status === 'capture_rejected') {
      return `${result.reason}: ${result.detail}`;
    }
    if (result.status === 'signaled') return `signal ${result.signal}`;
    if (result.status === 'command_failed') {
      return `command_failed: exit=${String(result.exitCode)} signal=${String(result.signal)}`;
    }
    if (result.status === 'sandbox_violation') return 'sandbox_violation';
    if (result.status === 'completed') return `exit ${result.exitCode}`;
    return result.status;
  }

  function persistCommandEvidence(result: CoreCommandOutcome): string {
    if (result.status === 'preflight_rejected' || result.status === 'capture_rejected') {
      return result.evidenceRef;
    }
    return opts.evidence.put(
      [
        `command-evidence:${JSON.stringify(result.evidence)}`,
        opts.evidence.getText(result.evidence.outputRef),
      ].join('\n'),
    );
  }

  async function runCommandCheck(name: string, cmd: string, frozen: FrozenTree): Promise<GateCheck> {
    try {
      return await withDisposableTree(frozen, async (workspaceRoot) => {
        // Keep both attempts inside one high-level RUN_COMMAND lifecycle so the
        // retry observes residue from the first attempt, while the surrounding
        // frozen checkout is still discarded after the check.
        const gateCommand = shellSingleQuote(cmd);
        const retryingCommand = [
          `gate_command=${gateCommand}`,
          '(eval "$gate_command")',
          'first_status=$?',
          'if [ "$first_status" -eq 0 ]; then exit 0; fi',
          '(eval "$gate_command")',
          'second_status=$?',
          `if [ "$second_status" -eq 0 ]; then printf '\\n${FLAKY_RETRY_MARKER}\\n'; exit ${FLAKY_RETRY_EXIT}; fi`,
          'exit "$second_status"',
        ].join('\n');
        const outcome = await commandExecutor.execute(
          {
            type: 'RUN_COMMAND',
            actionId: `gate-${name}`,
            cmd: retryingCommand,
            network: 'none',
            timeoutMs: 300_000,
          },
          {
            worktreeDir: workspaceRoot,
            role: 'implementer',
            classification: 'gate_check',
          },
        );
        const ref = persistCommandEvidence(outcome);
        if (outcome.status === 'completed' && outcome.exitCode === 0) {
          return { name, pass: true, evidenceRef: ref };
        }
        if (
          outcome.status === 'completed' &&
          outcome.exitCode === FLAKY_RETRY_EXIT &&
          opts.evidence.getText(ref).includes(FLAKY_RETRY_MARKER)
        ) {
          return {
            name,
            pass: false,
            flakySuspect: true,
            evidenceRef: ref,
            detail: 'fail-then-pass on retry: flaky_suspect, needs human review (never auto-quarantined)',
          };
        }
        return {
          name,
          pass: false,
          evidenceRef: ref,
          detail: failureDetail(outcome),
        };
      });
    } catch (error) {
      const detail = `frozen tree materialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return {
        name,
        pass: false,
        evidenceRef: opts.evidence.put(detail),
        detail,
      };
    }
  }

  async function runBuiltinCheck(
    name: string,
    frozen: FrozenTree,
    check: (workspaceRoot: string) => { pass: boolean; detail: string },
  ): Promise<GateCheck> {
    try {
      return await withDisposableTree(frozen, async (workspaceRoot) => {
        const verdict = check(workspaceRoot);
        return {
          name,
          pass: verdict.pass,
          evidenceRef: opts.evidence.put(verdict.detail),
          detail: verdict.detail,
        };
      });
    } catch (error) {
      const detail = `frozen tree materialization failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return {
        name,
        pass: false,
        evidenceRef: opts.evidence.put(detail),
        detail,
      };
    }
  }

  function resolveTargetedTests(): string | undefined {
    const t0 = config?.t0?.targetedTests;
    if (t0 === undefined) return undefined;
    // §6.4 T0: targeted-test selection starts as fallback = full unit suite.
    if (t0.startsWith('fallback:full_unit')) return config?.t1?.fullTests;
    return t0;
  }

  function nonEmptyCommand(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function phase0ConfigError(tier: 'T0' | 'T1'): string | null {
    if (configError !== null) return configError;
    if (config === null) return 'malformed gate configuration';
    if (tier === 'T0') {
      const missing: string[] = [];
      if (!nonEmptyCommand(config.t0?.lint)) missing.push('t0.lint');
      if (!nonEmptyCommand(config.t0?.typecheck)) missing.push('t0.typecheck');
      if (!nonEmptyCommand(config.t0?.targetedTests)) missing.push('t0.targetedTests');
      if (
        nonEmptyCommand(config.t0?.targetedTests) &&
        config.t0.targetedTests.startsWith('fallback:full_unit') &&
        !nonEmptyCommand(config.t1?.fullTests)
      ) {
        missing.push('t1.fullTests (required by t0 fallback)');
      }
      return missing.length === 0
        ? null
        : `missing or empty required Phase 0 checks: ${missing.join(', ')}`;
    }
    const missing: string[] = [];
    if (!nonEmptyCommand(config.t1?.fullTests)) missing.push('t1.fullTests');
    if (config.t1?.convention !== 'builtin') missing.push('t1.convention=builtin');
    if (config.t1?.golden !== 'builtin') missing.push('t1.golden=builtin');
    return missing.length === 0
      ? null
      : `missing or empty required Phase 0 checks: ${missing.join(', ')}`;
  }

  function configFailureCheck(detail: string): GateCheck {
    return {
      name: 'config',
      pass: false,
      evidenceRef: opts.evidence.put(detail),
      detail,
    };
  }

  function publish(report: GateReport): GateReport {
    const signed = opts.reportIntegrity.signGateReport(report, {
      runId: opts.runId,
      taskId: opts.taskId,
    });
    const appended = opts.fence === undefined
      ? opts.log.append({
          runId: opts.runId,
          taskId: opts.taskId,
          type: 'GATE_RESULT',
          payload: { ...signed } as unknown as Record<string, unknown>,
        })
      : opts.log.appendFenced({
          runId: opts.runId,
          taskId: opts.taskId,
          type: 'GATE_RESULT',
          payload: { ...signed } as unknown as Record<string, unknown>,
        }, opts.fence(), opts.clock.now());
    if (appended === null) throw new LeaseFenceError('task lease was lost before gate result commit');
    return signed;
  }

  async function runTier(tier: GateTier): Promise<GateReport> {
    const commitHash = readHeadCommit(opts.worktreeDir);
    // Bind the TESTED tree, not just HEAD (REQ-4.2): gates run mid-loop against
    // uncommitted writes. Hash of tracked+untracked content at gate entry —
    // checks may append their own artifacts (e.g. a flaky counter) while running.
    let frozen: FrozenTree;
    try {
      frozen = await freezeWorkingTree(opts.worktreeDir);
    } catch (error) {
      const detail = `frozen tree creation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      const report: GateReport = {
        tier,
        pass: false,
        gateConfigHash: effectiveGateConfigHash,
        commitHash,
        worktreeHash: 'unavailable',
        envHash: sha256Hex(
          JSON.stringify({
            platform: process.platform,
            node: process.version,
            commandEnvironmentHash: commandExecutor.environmentHash ?? 'injected-unspecified',
          }),
        ),
        checks: [configFailureCheck(detail)],
        scopeNote: SCOPE_NOTE,
      };
      return publish(report);
    }
    try {
    const worktreeHash = frozen.treeHash;
    const envHash = sha256Hex(
      JSON.stringify({
        platform: process.platform,
        node: process.version,
        commandEnvironmentHash: commandExecutor.environmentHash ?? 'injected-unspecified',
      }),
    );
    const base = {
      tier,
      gateConfigHash: effectiveGateConfigHash,
      commitHash,
      worktreeHash,
      envHash,
      scopeNote: SCOPE_NOTE,
    };

    if (tier === 'T3') {
      // Explicit stub — never a silent pass (REQ-8.4).
      return publish({ ...base, pass: 'not_enabled', checks: [] });
    }

    if (tier === 'T2') {
      const t2 = config?.t2;
      // {status} (or absent) stays the explicit stub (REQ-12.1); only the real
      // shape (build/scopedE2e/secretScan/fullGolden) turns T2 on (REQ-12.2).
      if (t2 === undefined || 'status' in t2) {
        return publish({ ...base, pass: 'not_enabled', checks: [] });
      }
      // Both union members are all-optional, so `in` alone can't narrow the
      // type (an empty object satisfies either) — the runtime check above is
      // exact; this just names the shape TS can't infer from it.
      const real = t2 as { build?: string; scopedE2e?: string; secretScan?: string; fullGolden?: 'builtin' };
      const checks: GateCheck[] = [];
      if (real.build !== undefined) checks.push(await runCommandCheck('build', real.build, frozen));
      if (real.scopedE2e !== undefined) checks.push(await runCommandCheck('scopedE2e', real.scopedE2e, frozen));
      if (real.secretScan !== undefined) checks.push(await runCommandCheck('secretScan', real.secretScan, frozen));
      if (real.fullGolden === 'builtin') {
        checks.push(
          await runBuiltinCheck('fullGolden', frozen, (workspaceRoot) => {
            const verdict = verifyGoldenManifest(workspaceRoot);
            return {
              pass: verdict.ok,
              detail: verdict.ok
                ? JSON.stringify(verdict)
                : `${verdict.reason}: ${verdict.detail}`,
            };
          }),
        );
      }
      const t2Report: GateReport = { ...base, pass: checks.every((c) => c.pass), checks };
      return publish(t2Report);
    }

    const invalidConfig = phase0ConfigError(tier);
    if (invalidConfig !== null) {
      const report: GateReport = {
        ...base,
        pass: false,
        checks: [configFailureCheck(invalidConfig)],
      };
      return publish(report);
    }

    const checks: GateCheck[] = [];
    if (tier === 'T0') {
      const t0 = config?.t0 ?? {};
      if (t0.lint !== undefined) checks.push(await runCommandCheck('lint', t0.lint, frozen));
      if (t0.typecheck !== undefined) checks.push(await runCommandCheck('typecheck', t0.typecheck, frozen));
      const targeted = resolveTargetedTests();
      if (targeted !== undefined) checks.push(await runCommandCheck('targetedTests', targeted, frozen));
    } else {
      const t1 = config?.t1 ?? {};
      if (t1.fullTests !== undefined) checks.push(await runCommandCheck('fullTests', t1.fullTests, frozen));
      if (t1.convention === 'builtin') {
        checks.push(
          await runBuiltinCheck('convention', frozen, (workspaceRoot) => {
            if (conventionPolicyError !== undefined || conventionPolicy === undefined) {
              return {
                pass: false,
                detail: conventionPolicyError ?? 'versioned convention policy is required',
              };
            }
            const result = checkConvention(workspaceRoot, conventionPolicy);
            return { pass: result.pass, detail: result.detail };
          }),
        );
      }
      if (t1.golden === 'builtin') {
        checks.push(
          await runBuiltinCheck('golden', frozen, (workspaceRoot) => {
            const verdict = verifyGoldenManifest(workspaceRoot);
            return {
              pass: verdict.ok,
              detail: verdict.ok
                ? JSON.stringify(verdict)
                : `${verdict.reason}: ${verdict.detail}`,
            };
          }),
        );
      }
    }

    const report: GateReport = {
      ...base,
      pass: checks.every((c) => c.pass),
      checks,
    };
    return publish(report);
    } finally {
      frozen.cleanup();
    }
  }

  return {
    run: runTier,
    verify(report) {
      return opts.reportIntegrity.verifyGateReport(report, {
        runId: opts.runId,
        taskId: opts.taskId,
      });
    },
  };
}
