import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GOVERNANCE_VIEWS,
  authFullBanner,
  enabledPluginNames,
  governanceEditor,
  governanceScopes,
  governanceView,
  parsePermissionInput,
  permissionRulePreview,
  provenanceRows,
  retentionPeriodDays,
  validateGovernanceDocument,
} from './govern.ts';

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

test('Governance registry and scope matrix expose only supported authority', () => {
  assert.equal(new Set(GOVERNANCE_VIEWS).size, 10);
  assert.equal(governanceView('hooks'), 'hooks');
  assert.equal(governanceView('unknown'), 'settings');
  assert.deepEqual(governanceScopes('settings'), ['managed', 'user', 'project', 'local']);
  assert.deepEqual(governanceScopes('mcp'), ['user', 'project']);
  assert.deepEqual(governanceScopes('permissions'), []);
});

test('redacted Governance source maps to replace-entire without editable placeholder', () => {
  assert.deepEqual(governanceEditor({
    content: '{"apiKey":"[redacted]"}',
    hash: 'raw-hash',
    scope: 'project',
    provenance: 'project MCP configuration',
    metadata: { sensitive: true, redacted: true },
  }), {
    displayContent: '{"apiKey":"[redacted]"}',
    editableContent: null,
    hash: 'raw-hash',
    readOnly: false,
    editMode: 'replace-entire',
    provenance: 'project MCP configuration',
  });
});

test('client validators cover JSON object, MCP shape, and Subagent frontmatter', () => {
  assert.equal(validateGovernanceDocument('settings', '{}'), null);
  assert.match(validateGovernanceDocument('settings', '[]') ?? '', /JSON object/u);
  assert.equal(validateGovernanceDocument('mcp', '{"mcpServers":{"x":{"command":"demo"}}}'), null);
  assert.match(validateGovernanceDocument('mcp', '{"mcpServers":{"x":{}}}') ?? '', /command or url/u);
  const agent = '---\nname: rev\ndescription: review\ntools: Read\n---\n# Body\n';
  assert.equal(validateGovernanceDocument('subagent', agent), null);
  assert.match(validateGovernanceDocument('subagent', '# missing') ?? '', /frontmatter/u);
});

test('permission input validates required fields and rule provenance shape', () => {
  assert.deepEqual(
    parsePermissionInput('[{"action":"deny","pattern":"Bash","scope":"project"}]', 'Bash', '/repo'),
    { rules: [{ action: 'deny', pattern: 'Bash', scope: 'project' }], tool: 'Bash', path: '/repo' },
  );
  assert.equal(parsePermissionInput('[]', '', '/repo'), 'tool and path are required');
  assert.match(String(parsePermissionInput('[{"action":"bad","pattern":"Bash"}]', 'Bash', '/repo')), /each rule/u);
});

test('field-specific Governance projections derive plugin state and retention period safely', () => {
  assert.deepEqual(enabledPluginNames('{"enabledPlugins":["z",1,"a"]}'), ['a', 'z']);
  assert.deepEqual(enabledPluginNames('invalid'), []);
  assert.equal(retentionPeriodDays('{"cleanupPeriodDays":30.8}'), 30);
  assert.equal(retentionPeriodDays('{"cleanupPeriodDays":-1}'), null);
});
