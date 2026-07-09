// Issue intake (spec §11.1 continuous stage "C. Issue intake", REQ-8/9). A
// local, no-webhook capture surface: `.ai/issues/<id>.json` records + a
// human-gated convert-to-draft-goal path. Body text is UNTRUSTED DATA (INV-3)
// end to end — this module only stores/echoes it, never interprets it.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from './govern.ts';

export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;
/** "objective from the body excerpt" (REQ-9.1) — keeps the draft goal.yaml scannable. */
const EXCERPT_MAX = 200;

export interface IssueRecord {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  status: 'open' | 'converted' | 'rejected';
  goalDraftPath?: string;
}

function issuePath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

function draftPath(dir: string, id: string): string {
  return join(dir, `${id}.goal.yaml`);
}

function readIssue(dir: string, id: string): IssueRecord | null {
  const p = issuePath(dir, id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as IssueRecord;
}

function writeIssue(dir: string, issue: IssueRecord): void {
  writeFileSync(issuePath(dir, issue.id), JSON.stringify(issue, null, 2));
}

/** Deterministic id (REQ-8.1): sha256(title, createdAt) — a separator keeps
 *  "ab"+"c" from hashing the same as "a"+"bc" (mirrors governance's proposalId). */
function issueId(title: string, createdAt: string): string {
  return `iss-${sha256([title, createdAt].join('\n')).slice(0, 16)}`;
}

export type CreateResult = { ok: true; issue: IssueRecord } | { ok: false; reason: 'too_large' };

/** REQ-8.2/8.3: create with status `open`; over either cap refuses and writes nothing. */
export function createIssue(dir: string, input: { title: string; body: string }, now: () => number): CreateResult {
  if (input.title.length > TITLE_MAX || input.body.length > BODY_MAX) return { ok: false, reason: 'too_large' };
  mkdirSync(dir, { recursive: true });
  const createdAt = new Date(now()).toISOString();
  const issue: IssueRecord = {
    id: issueId(input.title, createdAt),
    title: input.title,
    body: input.body,
    createdAt,
    status: 'open',
  };
  writeIssue(dir, issue);
  return { ok: true, issue };
}

/** REQ-8.4: list, oldest first. Only `<id>.json` files are records — `<id>.goal.yaml` drafts share the dir. */
export function listIssues(dir: string): IssueRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as IssueRecord)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * §11.1 budget defaults, verbatim. The unedited scaffold this produces is
 * structurally refused by `freezeContract` on its empty acceptance_criteria
 * alone (REQ-9.4, proven in issues.test.ts) — title/objective are JSON-escaped,
 * which is also valid YAML double-quoted-scalar escaping, so untrusted body
 * text (quotes, newlines, `#`) can never break out of the flow mapping.
 */
function goalDraftYaml(issue: IssueRecord): string {
  const excerpt = issue.body.length > EXCERPT_MAX ? `${issue.body.slice(0, EXCERPT_MAX)}…` : issue.body;
  return [
    '# HUMAN: fill ACs, risk, budget before running',
    `goal: { id: ${JSON.stringify(issue.id)}, title: ${JSON.stringify(issue.title)}, objective: ${JSON.stringify(excerpt)} }`,
    'acceptance_criteria: []',
    'budget: { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, max_total_tasks: 30, ' +
      'max_parallel_agents: 3, max_cost_units_per_task: 500, max_wallclock_per_task_min: 30 }',
    '',
  ].join('\n');
}

export type IssueOpResult = { ok: true; value: IssueRecord } | { ok: false; reason: 'not_found' | 'not_open' };

/** REQ-9.1/9.2/9.3: human-only convert — writes the draft file only; never starts/schedules/enqueues a run. */
export function convertIssue(dir: string, id: string): IssueOpResult {
  const issue = readIssue(dir, id);
  if (issue === null) return { ok: false, reason: 'not_found' };
  if (issue.status !== 'open') return { ok: false, reason: 'not_open' };
  const path = draftPath(dir, id);
  writeFileSync(path, goalDraftYaml(issue));
  const updated: IssueRecord = { ...issue, status: 'converted', goalDraftPath: path };
  writeIssue(dir, updated);
  return { ok: true, value: updated };
}

/** REQ-8.6: reject an open issue. */
export function rejectIssue(dir: string, id: string): IssueOpResult {
  const issue = readIssue(dir, id);
  if (issue === null) return { ok: false, reason: 'not_found' };
  if (issue.status !== 'open') return { ok: false, reason: 'not_open' };
  const updated: IssueRecord = { ...issue, status: 'rejected' };
  writeIssue(dir, updated);
  return { ok: true, value: updated };
}
