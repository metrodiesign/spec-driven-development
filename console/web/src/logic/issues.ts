// Pure display logic for F-Issue (REQ-8/9): status gating + client-side cap
// hints. The view (Issues.tsx) stays thin; the server is the real authority.
// web has no dependency on console/backend (like every other logic/*.ts here),
// so the shape is duplicated, not imported.

export interface IssueRecord {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  status: 'open' | 'converted' | 'rejected';
  goalDraftPath?: string;
}

export const TITLE_MAX = 200;
export const BODY_MAX = 20_000;

/** Mirrors the backend's open-only gate on convert/reject (advisory client-side — the server re-validates). */
export function canAct(issue: IssueRecord): boolean {
  return issue.status === 'open';
}

/** Client-side cap hint so a doomed submit never round-trips for a 413 — the server is the real authority. */
export function overCap(title: string, body: string): boolean {
  return title.length > TITLE_MAX || body.length > BODY_MAX;
}

export function mergeIssues(current: readonly IssueRecord[], incoming: readonly IssueRecord[]): readonly IssueRecord[] {
  const byId = new Map(current.map((issue) => [issue.id, issue]));
  for (const issue of incoming) byId.set(issue.id, issue);
  return [...byId.values()].sort((left, right) => {
    const byCreated = left.createdAt.localeCompare(right.createdAt);
    return byCreated === 0 ? left.id.localeCompare(right.id) : byCreated;
  });
}
