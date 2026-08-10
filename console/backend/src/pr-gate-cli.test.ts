import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrGateManager, PrGateProjection } from './pr-gate/manager.ts';
import { runPrGateCommand } from './pr-gate-cli.ts';

function projection(decision: PrGateProjection['systemDecision']): PrGateProjection {
  return {
    runId: 'prg-1', repository: 'acme/repo', pullRequest: 7, headSha: 'head-1', state: 'COMPLETED',
    systemDecision: decision, effectiveDecision: decision, reportRef: null, checkRunId: null,
    publication: 'NOT_STARTED', reviewerStatuses: [], overrideRefs: [], updatedAt: null,
  };
}

function manager(result: PrGateProjection, calls: unknown[]): PrGateManager {
  return {
    start: () => ({ runId: result.runId, completion: Promise.resolve(result) }),
    run: async (input) => { calls.push(input); return result; },
    runVerified: async () => result,
    cancel: async () => null,
    list: () => [],
    detail: () => null,
    headStatus: async () => null,
    override: async () => { throw new Error('unused'); },
    recoverInterrupted: () => [],
  };
}

test('pr-gate CLI validates args and invokes shared manager (REQ-10.1)', async () => {
  const calls: unknown[] = [];
  const result = await runPrGateCommand({ argv: ['run', '--repo', 'acme/repo', '--pr', '7'], manager: manager(projection('PASS'), calls) });
  assert.equal(result.code, 0);
  assert.deepEqual(calls, [{ repository: 'acme/repo', pullRequest: 7 }]);
  assert.equal(JSON.parse(result.out).systemDecision, 'PASS');

  const invalid = await runPrGateCommand({ argv: ['run', '--repo', 'bad', '--pr', 'zero'], manager: manager(projection('PASS'), []) });
  assert.equal(invalid.code, 1);
  assert.match(invalid.err, /usage/);
});

test('pr-gate CLI exit codes distinguish human, quality, and infrastructure outcomes', async () => {
  for (const [decision, code] of [
    ['PASS_WITH_WARNINGS', 0], ['HUMAN_REVIEW_REQUIRED', 2], ['FAIL', 3], ['INFRASTRUCTURE_FAILURE', 4],
  ] as const) {
    const result = await runPrGateCommand({ argv: ['run', '--repo', 'acme/repo', '--pr', '7'], manager: manager(projection(decision), []) });
    assert.equal(result.code, code, decision);
  }
});
