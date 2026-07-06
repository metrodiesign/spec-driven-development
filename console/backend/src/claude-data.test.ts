import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readProjects, readSessions } from './claude-data.ts';
import { addSession, makeHome } from '../test/helpers/home-fixture.ts';

test('projects list from live files, cwd recovered, loopManaged flagged (REQ-13.3)', () => {
  const fix = makeHome();
  try {
    const managedCwd = join(fix.homeDir, 'work', 'managed-app');
    mkdirSync(join(managedCwd, '.ai'), { recursive: true });
    writeFileSync(join(managedCwd, '.ai', 'goal.yaml'), 'goal: {}\n');
    addSession(fix, '-managed-app', 's1', [
      { cwd: managedCwd, timestamp: '2026-01-01T00:00:00Z' },
    ]);
    addSession(fix, '-plain-app', 's2', [
      { cwd: join(fix.homeDir, 'work', 'plain-app'), timestamp: '2026-01-01T00:00:00Z' },
    ]);

    const { projects, guidance } = readProjects(fix.homeDir);
    assert.equal(guidance, null);
    assert.equal(projects.length, 2);
    const managed = projects.find((p) => p.id === '-managed-app');
    assert.equal(managed?.loopManaged, true, '.ai/goal.yaml -> loop-managed banner (spec §8 F-Proj)');
    assert.equal(managed?.sessionCount, 1);
    const plain = projects.find((p) => p.id === '-plain-app');
    assert.equal(plain?.loopManaged, false);
  } finally {
    fix.cleanup();
  }
});

test('missing ~/.claude degrades to empty state with guidance (REQ-13.5)', () => {
  const fix = makeHome();
  try {
    const emptyHome = join(fix.homeDir, 'not-there');
    const { projects, guidance } = readProjects(emptyHome);
    assert.deepEqual(projects, []);
    assert.match(guidance ?? '', /run the CLI/);
  } finally {
    fix.cleanup();
  }
});

test('sessions parse live, malformed lines are skipped with warnings (REQ-13.4/13.6)', () => {
  const fix = makeHome();
  try {
    addSession(
      fix,
      '-app',
      'good',
      [
        { timestamp: '2026-01-01T10:00:00Z', cwd: '/x' },
        { timestamp: '2026-01-01T11:00:00Z' },
      ],
      { malformedLines: ['{not json', 'also-not-json}'] },
    );
    const { sessions, warnings } = readSessions(fix.homeDir, '-app');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.entryCount, 2, 'malformed lines not counted');
    assert.equal(sessions[0]?.firstTs, '2026-01-01T10:00:00Z');
    assert.equal(sessions[0]?.lastTs, '2026-01-01T11:00:00Z');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /skipped 2 malformed/);
  } finally {
    fix.cleanup();
  }
});

test('unknown project id degrades to empty with a warning, never throws (REQ-13.5)', () => {
  const fix = makeHome();
  try {
    const { sessions, warnings } = readSessions(fix.homeDir, '-missing');
    assert.deepEqual(sessions, []);
    assert.equal(warnings.length, 1);
  } finally {
    fix.cleanup();
  }
});
