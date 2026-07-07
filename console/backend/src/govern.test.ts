import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GUARD_RULES,
  installGuardRules,
  permissionDecision,
  resolveEffectiveSettings,
  sha256,
  writeSafe,
  type PermRule,
} from './govern.ts';

test('writeSafe: atomic write to a new file (REQ-14.2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gov-'));
  try {
    const p = join(root, 'settings.json');
    const r = writeSafe(p, '{"a":1}', null);
    assert.ok(r.ok);
    assert.equal(readFileSync(p, 'utf8'), '{"a":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeSafe: baseHash mismatch -> conflict, file untouched (REQ-14.2)', () => {
  const root = mkdtempSync(join(tmpdir(), 'gov-'));
  try {
    const p = join(root, 's.json');
    writeFileSync(p, 'original');
    const r = writeSafe(p, 'new', sha256('stale-hash-value'));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'conflict');
    assert.equal(readFileSync(p, 'utf8'), 'original', 'no last-write-wins clobber');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('writeSafe: matching baseHash succeeds; validation can reject', () => {
  const root = mkdtempSync(join(tmpdir(), 'gov-'));
  try {
    const p = join(root, 's.json');
    writeFileSync(p, 'v1');
    const ok = writeSafe(p, 'v2', sha256('v1'));
    assert.ok(ok.ok);
    const bad = writeSafe(p, 'not-json', sha256('v2'), (c) => (c.startsWith('{') ? null : 'must be JSON'));
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.reason, 'invalid');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveEffectiveSettings: later scope wins with provenance (REQ-14.3)', () => {
  const eff = resolveEffectiveSettings([
    { scope: 'managed', values: { model: 'opus', theme: 'dark' } },
    { scope: 'user', values: { model: 'sonnet' } },
    { scope: 'project', values: { theme: 'light' } },
  ]);
  assert.equal(eff['model']?.value, 'sonnet');
  assert.equal(eff['model']?.scope, 'user');
  assert.equal(eff['theme']?.value, 'light');
  assert.equal(eff['theme']?.scope, 'project');
});

test('permissionDecision: deny wins; glob paths; default ask (REQ-15.2)', () => {
  const rules: PermRule[] = [
    { action: 'allow', pattern: 'Write(src/**)' },
    { action: 'deny', pattern: 'Write(test/golden/**)' },
  ];
  assert.equal(permissionDecision(rules, 'Write', 'src/a.ts').decision, 'allow');
  assert.equal(permissionDecision(rules, 'Write', 'test/golden/x.txt').decision, 'deny');
  assert.equal(permissionDecision(rules, 'Bash', 'anything').decision, 'ask', 'no match -> ask');
});

test('installGuardRules protects golden + worktrees, idempotently (REQ-15.3)', () => {
  const once = installGuardRules([]);
  for (const g of GUARD_RULES) assert.ok(once.some((r) => r.pattern === g.pattern && r.action === 'deny'));
  const twice = installGuardRules(once);
  assert.equal(twice.length, once.length, 're-install adds nothing');
});
