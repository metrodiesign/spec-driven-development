// Live readers over Claude Code's own files (INV-11: no copies, no shadow state).
// Everything degrades to empty states with guidance — never a 500 (REQ-13.5/13.6).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectEntry {
  /** Munged directory name under ~/.claude/projects/ */
  id: string;
  /** Real cwd recovered from session JSONL (first entry's cwd), when available. */
  cwd: string | null;
  sessionCount: number;
  loopManaged: boolean;
}

export interface SessionEntry {
  sessionId: string;
  file: string;
  firstTs: string | null;
  lastTs: string | null;
  entryCount: number;
}

export interface SessionsResult {
  sessions: SessionEntry[];
  warnings: string[];
}

export function projectsDir(homeDir: string): string {
  return join(homeDir, '.claude', 'projects');
}

/** Parse a JSONL file line-by-line; malformed lines are skipped and counted (REQ-13.6). */
function scanJsonl(file: string): { entries: Record<string, unknown>[]; malformed: number } {
  const entries: Record<string, unknown>[] = [];
  let malformed = 0;
  const body = readFileSync(file, 'utf8');
  for (const line of body.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      malformed += 1;
    }
  }
  return { entries, malformed };
}

/**
 * Loop-managed = at least one PROMOTED goal contract at `.ai/specs/<feature>/goal.yaml`
 * (phase5-stage2 REQ-5.2/5.3): drafts (`goal.draft.yaml`) are pre-approval and never
 * count; the retired root `.ai/goal.yaml` is no longer consulted; `.ai/specs/archive/`
 * sits two levels down so the one-level scan structurally skips it. try/catch whole:
 * most home-dir projects have no `.ai/specs` at all — ENOENT is the common case.
 */
function hasPromotedGoal(cwd: string): boolean {
  const specsDir = join(cwd, '.ai', 'specs');
  try {
    return readdirSync(specsDir, { withFileTypes: true }).some(
      (d) => d.isDirectory() && existsSync(join(specsDir, d.name, 'goal.yaml')),
    );
  } catch {
    return false;
  }
}

export function readProjects(homeDir: string): { projects: ProjectEntry[]; guidance: string | null } {
  const dir = projectsDir(homeDir);
  if (!existsSync(dir)) {
    return {
      projects: [],
      guidance: 'no ~/.claude/projects directory found — run the CLI at least once, then reload',
    };
  }
  const projects: ProjectEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pdir = join(dir, entry.name);
    const jsonlFiles = readdirSync(pdir).filter((f) => f.endsWith('.jsonl'));
    let cwd: string | null = null;
    for (const f of jsonlFiles) {
      try {
        const { entries } = scanJsonl(join(pdir, f));
        const withCwd = entries.find((e) => typeof e['cwd'] === 'string');
        if (withCwd !== undefined) {
          cwd = withCwd['cwd'] as string;
          break;
        }
      } catch {
        // unreadable file — the project still lists
      }
    }
    projects.push({
      id: entry.name,
      cwd,
      sessionCount: jsonlFiles.length,
      loopManaged: cwd !== null && hasPromotedGoal(cwd),
    });
  }
  return { projects, guidance: null };
}

export function readSessions(homeDir: string, projectId: string): SessionsResult {
  const pdir = join(projectsDir(homeDir), projectId);
  if (!existsSync(pdir)) {
    return { sessions: [], warnings: [`project ${projectId} not found under ~/.claude/projects`] };
  }
  const sessions: SessionEntry[] = [];
  const warnings: string[] = [];
  for (const f of readdirSync(pdir).filter((n) => n.endsWith('.jsonl'))) {
    const file = join(pdir, f);
    try {
      const { entries, malformed } = scanJsonl(file);
      if (malformed > 0) warnings.push(`${f}: skipped ${malformed} malformed line(s)`);
      const timestamps = entries
        .map((e) => e['timestamp'])
        .filter((t): t is string => typeof t === 'string')
        .sort();
      sessions.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        file,
        firstTs: timestamps[0] ?? null,
        lastTs: timestamps[timestamps.length - 1] ?? null,
        entryCount: entries.length,
      });
    } catch (err) {
      warnings.push(`${f}: unreadable (${(err as Error).message})`);
    }
  }
  return { sessions, warnings };
}

/** Every session timestamp across all projects — raw material for the usage estimate. */
export function allTimestamps(homeDir: string): string[] {
  const dir = projectsDir(homeDir);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pdir = join(dir, entry.name);
    for (const f of readdirSync(pdir).filter((n) => n.endsWith('.jsonl'))) {
      try {
        if (statSync(join(pdir, f)).size > 50 * 1024 * 1024) continue; // skip pathological files
        const { entries } = scanJsonl(join(pdir, f));
        for (const e of entries) {
          if (typeof e['timestamp'] === 'string') out.push(e['timestamp']);
        }
      } catch {
        // unreadable — excluded from the estimate
      }
    }
  }
  return out.sort();
}
