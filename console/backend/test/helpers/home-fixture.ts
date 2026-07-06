// Fake ~/.claude home for console tests — the console reads LIVE files
// (INV-11), so tests hand it a synthetic home directory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HomeFixture {
  homeDir: string;
  dataDir: string;
  projectsDir: string;
  cleanup(): void;
}

export function makeHome(): HomeFixture {
  const homeDir = mkdtempSync(join(tmpdir(), 'console-home-'));
  const projectsDir = join(homeDir, '.claude', 'projects');
  mkdirSync(projectsDir, { recursive: true });
  return {
    homeDir,
    dataDir: join(homeDir, '.platform'),
    projectsDir,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

export function addSession(
  fix: HomeFixture,
  projectId: string,
  sessionId: string,
  entries: Record<string, unknown>[],
  opts?: { malformedLines?: string[] },
): void {
  const pdir = join(fix.projectsDir, projectId);
  mkdirSync(pdir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  if (opts?.malformedLines) lines.push(...opts.malformedLines);
  writeFileSync(join(pdir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
}
