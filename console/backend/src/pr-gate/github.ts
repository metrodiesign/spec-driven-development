import type {
  HumanOverride,
  QualityDecision,
  QualityDecisionReport,
  RepositoryId,
} from 'core';

import type { GitHubReportPort } from './manager.ts';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function repoPath(repository: RepositoryId): string {
  const [owner, name, extra] = repository.split('/');
  if (!owner || !name || extra !== undefined) throw new Error(`invalid GitHub repository: ${repository}`);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function decisionConclusion(decision: QualityDecision): 'success' | 'action_required' | 'failure' {
  if (decision === 'PASS' || decision === 'PASS_WITH_WARNINGS') return 'success';
  if (decision === 'HUMAN_REVIEW_REQUIRED') return 'action_required';
  return 'failure';
}

export function redactGitHubSummary(value: string, maxBytes = 6000): string {
  const redacted = value
    .replace(/\b(?:Bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/gu, '[REDACTED]')
    .replace(/\/Users\/[^/\s]+\//gu, '~/')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]');
  const bytes = Buffer.from(redacted);
  return bytes.byteLength <= maxBytes ? redacted : `${bytes.subarray(0, maxBytes - 24).toString('utf8')}\n[summary truncated]`;
}

function reportSummary(report: QualityDecisionReport, effective: QualityDecision, override?: HumanOverride): string {
  const lines = [
    `Decision: ${effective}`,
    `System decision: ${report.decision}`,
    `Head SHA: ${report.snapshot.headSha}`,
    `Risk: ${report.risk}`,
    `Analysis coverage: ${report.analysisCoverage}`,
    `Reviewer coverage: ${report.reviewerCoverage}`,
    `Cost units: ${report.costUnits}`,
    `Report: ${report.reportRef}`,
  ];
  if (report.reasons.length > 0) lines.push(`Reasons: ${report.reasons.join(', ')}`);
  if (override !== undefined) {
    lines.push(`Override: ${override.action} by ${override.actor}`);
    lines.push(`Override reason: ${override.reason}`);
  }
  return redactGitHubSummary(lines.join('\n'));
}

export function createGitHubChecksReporter(input: {
  token: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  checkName?: string;
}): GitHubReportPort {
  if (input.token.trim() === '') throw new Error('GitHub checks token is required');
  const fetcher = input.fetch ?? fetch;
  const base = (input.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/u, '');
  const now = input.now ?? Date.now;
  const name = input.checkName ?? 'Universal PR Quality Gate';

  const request = async (repository: RepositoryId, path: string, method: 'POST' | 'PATCH', body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetcher(`${base}/repos/${repoPath(repository)}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`GitHub Checks API ${method} ${path} failed with HTTP ${response.status}`);
    const parsed = await response.json() as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('GitHub Checks API returned invalid JSON');
    return parsed as Record<string, unknown>;
  };

  return {
    async start(descriptor, runId) {
      const result = await request(descriptor.repository, '/check-runs', 'POST', {
        name,
        head_sha: descriptor.headSha,
        status: 'in_progress',
        started_at: new Date(now()).toISOString(),
        external_id: runId,
        output: { title: name, summary: `Reviewing exact head ${descriptor.headSha}` },
      });
      if (typeof result['id'] !== 'number' && typeof result['id'] !== 'string') throw new Error('GitHub Check Run id missing');
      return String(result['id']);
    },
    async cancel(checkRunId, descriptor, reason) {
      await request(descriptor.repository, `/check-runs/${encodeURIComponent(checkRunId)}`, 'PATCH', {
        status: 'completed',
        conclusion: 'cancelled',
        completed_at: new Date(now()).toISOString(),
        output: { title: `${name}: cancelled`, summary: redactGitHubSummary(`Head ${descriptor.headSha}\nReason: ${reason}`) },
      });
    },
    async complete(checkRunId, descriptor, report, options) {
      const effective = options?.effectiveDecision ?? report.decision;
      if (descriptor.headSha !== report.snapshot.headSha) throw new Error('Check Run head does not match quality report');
      await request(descriptor.repository, `/check-runs/${encodeURIComponent(checkRunId)}`, 'PATCH', {
        status: 'completed',
        conclusion: decisionConclusion(effective),
        completed_at: new Date(now()).toISOString(),
        output: { title: `${name}: ${effective}`, summary: reportSummary(report, effective, options?.override) },
      });
    },
  };
}
