// Console governance surfaces — pure logic (REQ-12/13/14/15).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  confirmToken,
  jsonDiffPreview,
  redactGovernanceContent,
  retentionPreview,
  validateHookConfig,
  validateJsonObject,
  validateMcpConfig,
  validateSubagentFrontmatter,
} from './surfaces.ts';

test('confirmToken binds baseHash + content; a moved base or edit invalidates it (REQ-13.1)', () => {
  const t = confirmToken('base-1', 'content');
  assert.equal(confirmToken('base-1', 'content'), t, 'deterministic');
  assert.notEqual(confirmToken('base-2', 'content'), t, 'moved base -> new token');
  assert.notEqual(confirmToken('base-1', 'content!'), t, 'edited content -> new token');
  assert.notEqual(confirmToken(null, 'content'), confirmToken('', 'content-x'));
});

test('Governance redaction covers sensitive keys, credential URIs, private keys, and token shapes', () => {
  const credentialEndpoint = ["https://", "user:pas", "sword@ex", "ample.te", "st/path"].join('');
  const raw = JSON.stringify({
    apiKey: 'plain-secret',
    endpoint: credentialEndpoint,
    note: 'Bearer abcdefghijklmnop',
    pem: '-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----',
    safe: 'visible',
  });
  const view = redactGovernanceContent(raw);
  assert.equal(view.metadata.sensitive, true);
  assert.equal(view.metadata.redacted, true);
  assert.doesNotMatch(view.content, /plain-secret|user:password|abcdefghijklmnop|material/u);
  assert.match(view.content, /visible/u);
});

test('Governance redaction preserves clean bytes and JSON object validation rejects non-objects', () => {
  const clean = '{\n  "model": "opus"\n}\n';
  assert.deepEqual(redactGovernanceContent(clean), {
    content: clean,
    metadata: { sensitive: true, redacted: false },
  });
  assert.equal(validateJsonObject(clean), null);
  assert.match(validateJsonObject('[]') ?? '', /JSON object/u);
  assert.match(validateJsonObject('{') ?? '', /invalid JSON/u);
});

test('jsonDiffPreview reports exactly the lines that leave and arrive (REQ-13.2)', () => {
  const d = jsonDiffPreview('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(d.removed, ['b']);
  assert.deepEqual(d.added, ['d']);
});

test('jsonDiffPreview exposes line reordering instead of a false no-op (F3)', () => {
  assert.deepEqual(jsonDiffPreview('a\nb', 'b\na'), {
    removed: ['a'],
    added: ['a'],
  });
});

test('jsonDiffPreview preserves duplicate-line multiplicity (F4)', () => {
  assert.deepEqual(jsonDiffPreview('a\na', 'a'), {
    removed: ['a'],
    added: [],
  });
  assert.deepEqual(jsonDiffPreview('a', 'a\na'), {
    removed: [],
    added: ['a'],
  });
});

test('jsonDiffPreview bounds large sequence work with a conservative full replacement', () => {
  const before = Array.from({ length: 1_001 }, (_, i) => `line-${i}`);
  const after = [...before].reverse();
  assert.deepEqual(jsonDiffPreview(before.join('\n'), after.join('\n')), {
    removed: before,
    added: after,
  });
});

test('validateHookConfig: a well-formed hooks block passes (REQ-13.1)', () => {
  const ok = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './g.sh' }] }] },
  });
  assert.equal(validateHookConfig(ok), null);
  assert.equal(validateHookConfig('{}'), null, 'no hooks block = nothing to install, still valid');
});

test('validateHookConfig: unknown event, bad shape, or non-command handler are rejected (REQ-13.1)', () => {
  assert.match(validateHookConfig('{ not json') ?? '', /invalid JSON/);
  assert.match(validateHookConfig(JSON.stringify({ hooks: { Nope: [] } })) ?? '', /unknown hook event/);
  assert.match(
    validateHookConfig(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'eval' }] }] } })) ?? '',
    /unsupported handler type/,
  );
  assert.match(
    validateHookConfig(JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command' }] }] } })) ?? '',
    /requires a string "command"/,
  );
});

test('validateMcpConfig: stdio needs command, http needs url; else rejected (REQ-12.4)', () => {
  assert.equal(validateMcpConfig(JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { url: 'http://y' } } })), null);
  assert.equal(validateMcpConfig('{}'), null);
  assert.match(validateMcpConfig(JSON.stringify({ mcpServers: { a: { foo: 1 } } })) ?? '', /stdio "command" or an http "url"/);
});

test('validateSubagentFrontmatter: requires name/description/tools, preserves body verbatim (REQ-14.1/14.3)', () => {
  const good = '---\nname: r\ndescription: d\ntools: Read, Grep\n---\n# Body\nverbatim\n';
  const r = validateSubagentFrontmatter(good);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.parsed.name, 'r');
    assert.equal(r.parsed.body, '# Body\nverbatim\n', 'body preserved verbatim');
  }
  const bad = validateSubagentFrontmatter('---\nname: r\n---\nbody');
  assert.ok(!bad.ok);
  const noFm = validateSubagentFrontmatter('# no frontmatter');
  assert.ok(!noFm.ok);
});

test('retentionPreview lists only files older than the cleanup window (REQ-15.3)', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  const files = [
    { path: 'old.jsonl', mtimeMs: now - 40 * day },
    { path: 'fresh.jsonl', mtimeMs: now - 5 * day },
  ];
  assert.deepEqual(retentionPreview(files, 30, now), ['old.jsonl']);
  assert.deepEqual(retentionPreview(files, 3, now), ['fresh.jsonl', 'old.jsonl'].sort());
});
