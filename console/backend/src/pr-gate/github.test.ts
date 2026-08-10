import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { QualityDecision, QualityDecisionReport } from 'core';

import { createGitHubChecksReporter, decisionConclusion, redactGitHubSummary } from './github.ts';

test('quality decisions map to exact GitHub Check conclusions', () => {
  const table: Array<[QualityDecision, string]> = [
    ['PASS', 'success'],
    ['PASS_WITH_WARNINGS', 'success'],
    ['HUMAN_REVIEW_REQUIRED', 'action_required'],
    ['FAIL', 'failure'],
    ['INFRASTRUCTURE_FAILURE', 'failure'],
  ];
  for (const [decision, expected] of table) assert.equal(decisionConclusion(decision), expected);
});

test('GitHub reporter binds exact head and sends bounded redacted summary', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reporter = createGitHubChecksReporter({
    token: 'reporter-credential',
    now: () => 0,
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({ id: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const descriptor = {
    repository: 'acme/repo' as const,
    number: 1,
    title: 'x',
    description: 'y',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    fromFork: false,
  };
  const id = await reporter.start(descriptor, 'RUN-1');
  const report: QualityDecisionReport = {
    runId: 'RUN-1',
    snapshot: { repository: 'acme/repo', pullRequest: 1, baseSha: descriptor.baseSha, headSha: descriptor.headSha, mergeBaseSha: 'c'.repeat(40), diffRef: `sha256:${'d'.repeat(64)}`, policyRef: `sha256:${'e'.repeat(64)}` },
    decision: 'PASS',
    reasons: [],
    profiles: [],
    risk: 'LOW',
    analysisCoverage: 'FULL',
    reviewerCoverage: 'FULL',
    deterministicReportRef: `sha256:${'1'.repeat(64)}`,
    judgedFindingRefs: [],
    consensusRef: `sha256:${'2'.repeat(64)}`,
    policyRef: `sha256:${'e'.repeat(64)}`,
    costUnits: 1,
    durationMs: 2,
    reportRef: `sha256:${'3'.repeat(64)}`,
  };
  await reporter.complete(id, descriptor, report);
  const startBody = JSON.parse(String(calls[0]?.init?.body)) as { head_sha: string };
  const finalBody = JSON.parse(String(calls[1]?.init?.body)) as { conclusion: string; output: { summary: string } };
  assert.equal(startBody.head_sha, descriptor.headSha);
  assert.equal(finalBody.conclusion, 'success');
  assert.ok(Buffer.byteLength(finalBody.output.summary) <= 6000);
  assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization, 'Bearer reporter-credential');
  assert.ok(!String(calls[0]?.init?.body).includes('reporter-credential'));
});

test('summary redaction removes token, private home, and email', () => {
  const token = ['ghp', '_', 'A'.repeat(30)].join('');
  const out = redactGitHubSummary(`${token} /Users/alice/project alice@example.com`);
  assert.doesNotMatch(out, /ghp_|\/Users\/alice|alice@example/);
});
