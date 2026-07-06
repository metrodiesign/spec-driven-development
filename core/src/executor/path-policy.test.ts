import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDefaultPathPolicy } from './path-policy.ts';

const policy = createDefaultPathPolicy();

test('role write allowlists follow §6.1 defaults (REQ-1.6)', () => {
  assert.equal(policy.checkWrite('planner', 'src/a.ts').allowed, false, 'planner read-only');
  assert.equal(policy.checkWrite('test_designer', 'test/ai-generated/x.test.ts').allowed, true);
  assert.equal(policy.checkWrite('test_designer', 'src/a.ts').allowed, false);
  assert.equal(policy.checkWrite('implementer', 'src/a.ts').allowed, true);
  assert.equal(policy.checkWrite('implementer', 'test/ai-generated/x.test.ts').allowed, true);
  assert.equal(policy.checkWrite('implementer', 'docs/readme.md').allowed, false);
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
