import { createHash } from 'node:crypto';

import { canonicalEvidenceBytes } from '../evidence/auth.ts';
import type {
  DeterministicCheckSpec,
  DeterministicReport,
  Sha256Ref,
  SnapshotIdentity,
} from './types.ts';

export interface PlannedCheckOutcome {
  status: 'PASSED' | 'FAILED' | 'TIMED_OUT' | 'INFRASTRUCTURE_FAILURE';
  durationMs: number;
  evidenceRef: Sha256Ref;
}

export interface PlannedCheckExecutor {
  execute(check: Readonly<DeterministicCheckSpec>, signal: AbortSignal): Promise<PlannedCheckOutcome>;
}

/** Fail closed when an imported report omits, duplicates, adds, or weakens a trusted planned check. */
export function assertDeterministicReportMatchesPlan(
  checks: readonly DeterministicCheckSpec[],
  report: DeterministicReport,
): void {
  const planned = new Map(checks.map((check) => [check.id, check]));
  const seen = new Set<string>();
  if (planned.size !== checks.length || report.checks.length !== checks.length) {
    throw new Error('deterministic report does not match resolved check plan');
  }
  for (const result of report.checks) {
    const check = planned.get(result.id);
    if (
      check === undefined || seen.has(result.id) || result.required !== check.required ||
      !['PASSED', 'FAILED', 'TIMED_OUT', 'INFRASTRUCTURE_FAILURE'].includes(result.status) ||
      !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
      !/^sha256:[0-9a-f]{64}$/u.test(result.evidenceRef)
    ) {
      throw new Error('deterministic report does not match resolved check plan');
    }
    seen.add(result.id);
  }
}

function sha256Ref(content: Uint8Array): Sha256Ref {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export async function runPlannedChecks(input: {
  snapshot: SnapshotIdentity;
  checks: readonly DeterministicCheckSpec[];
  executor: PlannedCheckExecutor;
  signal: AbortSignal;
}): Promise<DeterministicReport> {
  const results: DeterministicReport['checks'] = [];
  for (const check of input.checks) {
    if (input.signal.aborted) throw input.signal.reason;
    if (check.network !== 'none' || check.install !== false) {
      throw new Error(`check ${check.id} violates enforcing isolation policy`);
    }
    const timeout = AbortSignal.timeout(check.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    let outcome: PlannedCheckOutcome;
    try {
      outcome = await input.executor.execute(Object.freeze({ ...check }), signal);
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (timeout.aborted) {
        outcome = {
          status: 'TIMED_OUT',
          durationMs: check.timeoutMs,
          evidenceRef: sha256Ref(canonicalEvidenceBytes({ checkId: check.id, status: 'TIMED_OUT' })),
        };
      } else {
        throw error;
      }
    }
    results.push({
      id: check.id,
      status: outcome.status,
      required: check.required,
      durationMs: outcome.durationMs,
      evidenceRef: outcome.evidenceRef,
    });
  }
  const unsigned = { snapshot: input.snapshot, checks: results };
  const report = { ...unsigned, reportRef: sha256Ref(canonicalEvidenceBytes(unsigned)) };
  assertDeterministicReportMatchesPlan(input.checks, report);
  return report;
}
