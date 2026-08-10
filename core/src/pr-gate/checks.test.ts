import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertDeterministicReportMatchesPlan, runPlannedChecks, type PlannedCheckOutcome } from './checks.ts';
import type { DeterministicCheckSpec, DeterministicReport, Sha256Ref, SnapshotIdentity } from './types.ts';

const REF = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Sha256Ref;
const snapshot: SnapshotIdentity = {
  repository: 'owner/repo',
  pullRequest: 1,
  baseSha: 'base',
  headSha: 'head',
  mergeBaseSha: 'base',
  diffRef: REF,
  policyRef: REF,
};

function check(id: string, required = true): DeterministicCheckSpec {
  return {
    id,
    kind: 'test',
    command: `run ${id}`,
    required,
    timeoutMs: 1_000,
    network: 'none',
    install: false,
    profiles: [],
    components: [],
  };
}

describe('planned deterministic checks', () => {
  it('REQ-4 runs the exact resolved plan and continues after a required failure', async () => {
    const seen: string[] = [];
    const outcomes: Record<string, PlannedCheckOutcome> = {
      build: { status: 'FAILED', durationMs: 5, evidenceRef: REF },
      scan: { status: 'PASSED', durationMs: 3, evidenceRef: REF },
    };
    const report = await runPlannedChecks({
      snapshot,
      checks: [check('build'), check('scan')],
      signal: new AbortController().signal,
      executor: {
        async execute(spec) {
          seen.push(`${spec.id}:${spec.command}:${spec.network}:${String(spec.install)}`);
          return outcomes[spec.id]!;
        },
      },
    });
    assert.deepEqual(seen, ['build:run build:none:false', 'scan:run scan:none:false']);
    assert.deepEqual(report.checks.map((result) => result.status), ['FAILED', 'PASSED']);
    assert.match(report.reportRef, /^sha256:[0-9a-f]{64}$/u);
  });

  it('REQ-4 fails closed before execution for a loosened isolation spec', async () => {
    let executed = false;
    await assert.rejects(
      runPlannedChecks({
        snapshot,
        checks: [{ ...check('unsafe'), network: 'allow' } as unknown as DeterministicCheckSpec],
        signal: new AbortController().signal,
        executor: {
          async execute() {
            executed = true;
            return { status: 'PASSED', durationMs: 0, evidenceRef: REF };
          },
        },
      }),
      /violates enforcing isolation policy/u,
    );
    assert.equal(executed, false);
  });

  it('REQ-8 propagates cancellation before the next check', async () => {
    const controller = new AbortController();
    let count = 0;
    await assert.rejects(
      runPlannedChecks({
        snapshot,
        checks: [check('one'), check('two')],
        signal: controller.signal,
        executor: {
          async execute() {
            count += 1;
            controller.abort(new Error('cancelled'));
            return { status: 'PASSED', durationMs: 1, evidenceRef: REF };
          },
        },
      }),
      /cancelled/u,
    );
    assert.equal(count, 1);
  });

  it('REQ-4/REQ-9 rejects an imported report that omits, duplicates, or weakens a planned check', () => {
    const checks = [check('build'), check('scan', false)];
    const report: DeterministicReport = {
      snapshot,
      checks: checks.map((item) => ({ id: item.id, status: 'PASSED', required: item.required, durationMs: 1, evidenceRef: REF })),
      reportRef: REF,
    };
    assert.doesNotThrow(() => assertDeterministicReportMatchesPlan(checks, report));
    assert.throws(() => assertDeterministicReportMatchesPlan(checks, { ...report, checks: report.checks.slice(0, 1) }), /resolved check plan/u);
    assert.throws(() => assertDeterministicReportMatchesPlan(checks, { ...report, checks: [report.checks[0]!, report.checks[0]!] }), /resolved check plan/u);
    assert.throws(() => assertDeterministicReportMatchesPlan(checks, { ...report, checks: report.checks.map((item) => ({ ...item, required: false })) }), /resolved check plan/u);
  });
});
