import assert from 'node:assert/strict';
import { sep } from 'node:path';
import { test } from 'node:test';

import { createDefaultPathPolicy, normalizeWorktreeRelativePath } from './path-policy.ts';

const policy = createDefaultPathPolicy();

/**
 * Every `path` shape a model can emit that is not a usable string. `''` is the
 * pre-existing empty-string case, kept here so the two rejection routes (type
 * guard and length guard) are covered by one table.
 */
const NON_STRING_PATHS: readonly unknown[] = [
  undefined,
  null,
  42,
  0,
  true,
  [],
  ['src/a.ts'],
  {},
  { path: 'src/a.ts' },
  '',
];

test('role write allowlists follow §6.1 defaults (REQ-1.6)', () => {
  assert.equal(policy.checkWrite('planner', 'src/a.ts').allowed, false, 'planner read-only');
  assert.equal(policy.checkWrite('test_designer', 'test/ai-generated/x.test.ts').allowed, true);
  assert.equal(policy.checkWrite('test_designer', 'src/a.ts').allowed, false);
  assert.equal(policy.checkWrite('implementer', 'src/a.ts').allowed, true);
  assert.equal(policy.checkWrite('implementer', 'test/ai-generated/x.test.ts').allowed, true);
  assert.equal(policy.checkWrite('implementer', 'docs/readme.md').allowed, false);
});

test('writeRoots exposes the per-role durable-write allowlist for every role (REQ-1.6)', () => {
  const aiGenerated = `test${sep}ai-generated`;
  assert.deepEqual(policy.writeRoots('planner'), []);
  assert.deepEqual(policy.writeRoots('test_designer'), [aiGenerated]);
  assert.deepEqual(policy.writeRoots('implementer'), ['src', aiGenerated]);
  assert.deepEqual(policy.writeRoots('diagnostician'), []);
  assert.deepEqual(policy.writeRoots('reviewer'), []);
});

test('golden is read-only for every role, decision names the reason (REQ-1.3)', () => {
  for (const role of ['planner', 'test_designer', 'implementer'] as const) {
    const d = policy.checkWrite(role, 'test/golden/expected.txt');
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.reason, 'golden_write_denied');
  }
});

test('escape attempts are rejected: absolute, traversal, sneaky normalization (REQ-1.2)', () => {
  for (const p of ['/etc/passwd', '../outside.txt', 'src/../../escape', 'src/../test/golden/x']) {
    const d = policy.checkWrite('implementer', p);
    assert.equal(d.allowed, false, `must reject ${p}`);
  }
  // Normalizing 'src/../test/golden/x' lands in golden — either reason is a correct denial.
});

test('reads stay inside the worktree for all roles (REQ-1.2)', () => {
  assert.equal(policy.checkRead('planner', 'src/a.ts').allowed, true);
  assert.equal(policy.checkRead('planner', 'test/golden/expected.txt').allowed, true);
  assert.equal(policy.checkRead('implementer', '../secrets.env').allowed, false);
  assert.equal(policy.checkRead('implementer', '/etc/hosts').allowed, false);
});

test('AC-1: a non-string path normalizes to null instead of throwing a TypeError', () => {
  // `isAbsolute()` throws `TypeError: The "path" argument must be of type
  // string` on every one of these, which used to escape propose()/execute().
  for (const bad of NON_STRING_PATHS) {
    assert.equal(
      normalizeWorktreeRelativePath(bad),
      null,
      `path=${JSON.stringify(bad) ?? 'undefined'} must normalize to null`,
    );
  }
});

test('AC-1: checkRead/checkWrite deny a non-string path as path_outside_allowlist, never throw', () => {
  for (const bad of NON_STRING_PATHS) {
    const label = `path=${JSON.stringify(bad) ?? 'undefined'}`;
    const read = policy.checkRead('implementer', bad as string);
    assert.equal(read.allowed, false, `${label} must be denied for read`);
    if (!read.allowed) assert.equal(read.reason, 'path_outside_allowlist', label);
    const write = policy.checkWrite('implementer', bad as string);
    assert.equal(write.allowed, false, `${label} must be denied for write`);
    if (!write.allowed) assert.equal(write.reason, 'path_outside_allowlist', label);
  }
});

test('checkCommand grants only implementer and diagnostician (spec §6.1)', () => {
  for (const role of ['implementer', 'diagnostician'] as const) {
    assert.equal(policy.checkCommand(role).allowed, true, `${role} may run commands`);
  }
  for (const role of ['planner', 'test_designer', 'reviewer'] as const) {
    const d = policy.checkCommand(role);
    assert.equal(d.allowed, false, `${role} may not run commands`);
    if (!d.allowed) assert.equal(d.reason, 'command_role_denied', role);
  }
});

test('AC-2: string paths keep their pre-guard behaviour exactly', () => {
  assert.equal(normalizeWorktreeRelativePath('src/a.ts'), 'src/a.ts');
  assert.equal(normalizeWorktreeRelativePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeWorktreeRelativePath('src/../test/golden/x'), 'test/golden/x');
  assert.equal(normalizeWorktreeRelativePath('../escape.ts'), null);
  assert.equal(normalizeWorktreeRelativePath('..'), null);
  assert.equal(normalizeWorktreeRelativePath('/etc/passwd'), null);
  assert.equal(policy.checkRead('implementer', 'src/a.ts').allowed, true);
  const escaped = policy.checkRead('implementer', '../escape.ts');
  assert.equal(escaped.allowed, false);
  if (!escaped.allowed) assert.equal(escaped.reason, 'path_outside_allowlist');
});
