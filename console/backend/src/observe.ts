// Observability logic (spec §8; REQ-18/19/20). Pure, unit-tested pieces: the
// usage indexer (day/project/model + interactive-vs-autonomous split by session
// cwd), alert evaluation, the fail-open activity hook entry, and a rebuildable
// FTS5 session search. Numbers are ESTIMATES with no hardcoded caps (INV-13).

import { DatabaseSync } from 'node:sqlite';

export interface UsageRecord {
  ts: string; // ISO
  project: string;
  model: string;
  /** Session cwd — adapter sessions live under the agent-sessions prefix (autonomous). */
  cwd: string;
}

export interface UsageIndex {
  byDay: Record<string, number>;
  byProject: Record<string, number>;
  byModel: Record<string, number>;
  interactive: number;
  autonomous: number;
  label: 'estimate';
}

/** Group usage and split interactive vs autonomous by session cwd (REQ-18.1/18.2). */
export function indexUsage(records: UsageRecord[], agentSessionsPrefix: string): UsageIndex {
  const byDay: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let interactive = 0;
  let autonomous = 0;
  for (const r of records) {
    const day = r.ts.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
    byProject[r.project] = (byProject[r.project] ?? 0) + 1;
    byModel[r.model] = (byModel[r.model] ?? 0) + 1;
    if (r.cwd.startsWith(agentSessionsPrefix)) autonomous += 1;
    else interactive += 1;
  }
  return { byDay, byProject, byModel, interactive, autonomous, label: 'estimate' };
}

export interface AlertThreshold {
  name: string;
  metric: 'interactive' | 'autonomous' | 'total';
  limit: number;
}

export interface Alert {
  name: string;
  metric: string;
  value: number;
  limit: number;
  /** Labeled so the operator knows which pool a run counted against (§5.3). */
  kind: 'interactive' | 'non-interactive' | 'total';
}

export function evalAlerts(index: UsageIndex, thresholds: AlertThreshold[]): Alert[] {
  const total = index.interactive + index.autonomous;
  const valueOf = (m: AlertThreshold['metric']): number =>
    m === 'interactive' ? index.interactive : m === 'autonomous' ? index.autonomous : total;
  return thresholds
    .filter((t) => valueOf(t.metric) >= t.limit)
    .map((t) => ({
      name: t.name,
      metric: t.metric,
      value: valueOf(t.metric),
      limit: t.limit,
      kind: t.metric === 'autonomous' ? 'non-interactive' : t.metric === 'interactive' ? 'interactive' : 'total',
    }));
}

/** A fail-open activity hook entry (REQ-19.1): a short timeout and failures never
 *  block Claude Code. The timeout is bounded by the policy key. */
export function activityHookEntry(ingestUrl: string, token: string, timeoutMs: number): Record<string, unknown> {
  return {
    type: 'command',
    command: `curl -sS -m ${Math.max(1, Math.ceil(timeoutMs / 1000))} -H 'x-ingest-token: ${token}' -X POST ${ingestUrl} || true`,
    failOpen: true,
    timeoutMs,
  };
}

/** Rebuildable FTS5 index over session text (REQ-20.1) — domain data, INV-11 legal. */
export interface SessionDoc {
  sessionId: string;
  project: string;
  text: string;
}

export interface SessionSearch {
  search(query: string): { sessionId: string; project: string }[];
  close(): void;
}

export function buildSessionSearch(docs: SessionDoc[]): SessionSearch {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE sess USING fts5(sessionId UNINDEXED, project UNINDEXED, text)');
  const insert = db.prepare('INSERT INTO sess(sessionId, project, text) VALUES (?, ?, ?)');
  for (const d of docs) insert.run(d.sessionId, d.project, d.text);
  return {
    search(query) {
      // FTS5 MATCH; a plain phrase is quoted so operator chars don't break it.
      const stmt = db.prepare('SELECT sessionId, project FROM sess WHERE sess MATCH ? ORDER BY rank');
      const rows = stmt.all(`"${query.replace(/"/g, '""')}"`) as { sessionId: string; project: string }[];
      return rows.map((r) => ({ sessionId: r.sessionId, project: r.project }));
    },
    close() {
      db.close();
    },
  };
}
