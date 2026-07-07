import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authFullBanner, permissionRulePreview, provenanceRows } from './govern.ts';

test('provenanceRows shows the winning scope per key, sorted', () => {
  const rows = provenanceRows({ model: { value: 'opus', scope: 'project' }, theme: { value: 'dark', scope: 'user' } });
  assert.equal(rows[0], 'model = "opus"  (from project)');
  assert.equal(rows[1], 'theme = "dark"  (from user)');
});

test('permissionRulePreview renders the CLI-style rule', () => {
  assert.equal(permissionRulePreview({ action: 'deny', pattern: 'Write(test/golden/**)' }), 'DENY Write(test/golden/**)');
  assert.equal(permissionRulePreview({ action: 'ask', pattern: 'Bash' }), 'ASK Bash');
});

test('authFullBanner is red when shadowed', () => {
  const red = authFullBanner({ severity: 'red', shadowingVars: ['ANTHROPIC_API_KEY'], guidance: 'unset it' });
  assert.equal(red.level, 'red');
  assert.match(red.text, /ANTHROPIC_API_KEY/);
  assert.equal(authFullBanner({ severity: 'ok', shadowingVars: [], guidance: null }).level, 'ok');
});
