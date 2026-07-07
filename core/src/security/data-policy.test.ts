// Provider data policy (REQ-11.5/11.8). Every pathed piece must match an allow
// glob; a pathless piece passes only for an enumerated platform kind. All-or-
// nothing: the first violation refuses the whole send (no partial-bundle leak).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkDataPolicy, type ProviderDataPolicy } from './data-policy.ts';
import type { ContextPiece } from '../types.ts';

const POLICY: ProviderDataPolicy = {
  allowPaths: ['src/**', 'test/**', '*.md'],
  pathlessKinds: ['feedback', 'contract', 'guidance', 'patchPlan'],
};

const piece = (o: Partial<ContextPiece>): ContextPiece => ({
  id: 'p',
  kind: 'file',
  content: '',
  reason: 'seed',
  ...o,
});

test('in-policy paths pass (REQ-11.5)', () => {
  const pieces = [
    piece({ id: 'a', path: 'src/x/y.ts' }),
    piece({ id: 'b', path: 'test/z.test.ts' }),
    piece({ id: 'c', path: 'README.md' }),
  ];
  assert.deepEqual(checkDataPolicy(pieces, POLICY), { ok: true });
});

test('an out-of-policy path blocks the whole send (REQ-11.5)', () => {
  const pieces = [piece({ id: 'a', path: 'src/ok.ts' }), piece({ id: 'secret', path: 'infra/creds.env' })];
  const r = checkDataPolicy(pieces, POLICY);
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.violation.reason, 'path_out_of_policy');
    assert.equal(r.violation.pieceId, 'secret');
  }
});

test('`*` matches within a segment, never across `/` (glob discipline)', () => {
  const p: ProviderDataPolicy = { allowPaths: ['src/*.ts'], pathlessKinds: [] };
  assert.equal(checkDataPolicy([piece({ path: 'src/a.ts' })], p).ok, true);
  assert.equal(checkDataPolicy([piece({ path: 'src/sub/a.ts' })], p).ok, false);
});

test('a pathless piece passes only for an enumerated platform kind (REQ-11.8)', () => {
  assert.equal(checkDataPolicy([piece({ id: 'f', kind: 'feedback' })], POLICY).ok, true);
  assert.equal(checkDataPolicy([piece({ id: 'c', kind: 'contract' })], POLICY).ok, true);
});

test('a pathless piece of a non-enumerated kind escalates (REQ-11.8)', () => {
  const r = checkDataPolicy([piece({ id: 'x', kind: 'excerpt' })], POLICY);
  assert.ok(!r.ok);
  if (!r.ok) {
    assert.equal(r.violation.reason, 'pathless_kind_not_allowed');
    assert.equal(r.violation.kind, 'excerpt');
  }
});
