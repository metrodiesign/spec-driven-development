import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { readProjects, readSessions } from './claude-data.ts';
import { addSession, makeHome } from '../test/helpers/home-fixture.ts';

test('projects list from live files, cwd recovered, loopManaged flagged (REQ-13.3; loopManaged semantics = phase5-stage2 REQ-5.2)', () => {
  const fix = makeHome();
  try {
    const managedCwd = join(fix.homeDir, 'work', 'managed-app');
    mkdirSync(join(managedCwd, '.ai', 'specs', 'user-auth'), { recursive: true });
    writeFileSync(join(managedCwd, '.ai', 'specs', 'user-auth', 'goal.yaml'), 'goal: {}\n');
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
    assert.equal(managed?.loopManaged, true, '.ai/specs/<feature>/goal.yaml -> loop-managed banner (REQ-5.2)');
    assert.equal(managed?.sessionCount, 1);
    const plain = projects.find((p) => p.id === '-plain-app');
    assert.equal(plain?.loopManaged, false);
  } finally {
    fix.cleanup();
  }
});

test('loopManaged: draft-only, no goal file, and legacy root .ai/goal.yaml are all FALSE; a promoted per-feature goal.yaml is TRUE (phase5-stage2 REQ-5.2/5.3/6.7)', () => {
  const fix = makeHome();
  try {
    // (a) promoted — .ai/specs/<feature>/goal.yaml exists
    const promoted = join(fix.homeDir, 'work', 'promoted-app');
    mkdirSync(join(promoted, '.ai', 'specs', 'feat-x'), { recursive: true });
    writeFileSync(join(promoted, '.ai', 'specs', 'feat-x', 'goal.yaml'), 'goal: {}\n');
    addSession(fix, '-promoted-app', 's1', [{ cwd: promoted, timestamp: '2026-01-01T00:00:00Z' }]);

    // (b) draft only — pre-approval, never counts (REQ-5.3)
    const draftOnly = join(fix.homeDir, 'work', 'draft-app');
    mkdirSync(join(draftOnly, '.ai', 'specs', 'feat-y'), { recursive: true });
    writeFileSync(join(draftOnly, '.ai', 'specs', 'feat-y', 'goal.draft.yaml'), 'goal: {}\n');
    addSession(fix, '-draft-app', 's2', [{ cwd: draftOnly, timestamp: '2026-01-01T00:00:00Z' }]);

    // (c) legacy root .ai/goal.yaml — retired convention, no longer consulted (REQ-5.2)
    const legacy = join(fix.homeDir, 'work', 'legacy-app');
    mkdirSync(join(legacy, '.ai'), { recursive: true });
    writeFileSync(join(legacy, '.ai', 'goal.yaml'), 'goal: {}\n');
    addSession(fix, '-legacy-app', 's3', [{ cwd: legacy, timestamp: '2026-01-01T00:00:00Z' }]);

    // (d) no goal file at all (has .ai/specs but empty feature folder)
    const bare = join(fix.homeDir, 'work', 'bare-app');
    mkdirSync(join(bare, '.ai', 'specs', 'feat-z'), { recursive: true });
    addSession(fix, '-bare-app', 's4', [{ cwd: bare, timestamp: '2026-01-01T00:00:00Z' }]);

    const { projects } = readProjects(fix.homeDir);
    const flag = (id: string): boolean | undefined => projects.find((p) => p.id === id)?.loopManaged;
    assert.equal(flag('-promoted-app'), true, 'promoted goal.yaml counts');
    assert.equal(flag('-draft-app'), false, 'goal.draft.yaml never counts');
    assert.equal(flag('-legacy-app'), false, 'retired root .ai/goal.yaml no longer consulted');
    assert.equal(flag('-bare-app'), false, 'no goal file -> false');
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
