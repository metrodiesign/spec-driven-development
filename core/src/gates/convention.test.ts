import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  checkConvention,
  ConventionPolicyError,
  parseConventionPolicy,
} from './convention.ts';

const POLICY = parseConventionPolicy(JSON.stringify({
  version: 1,
  roots: ['test'],
  rules: [
    { id: 'focus-skip', pattern: '\\.\\s*(?:only|skip)\\s*\\(', extensions: ['.ts'] },
    { id: 'typecheck-bypass', pattern: '@ts-ignore|skipLibCheck\\s*:\\s*true', extensions: ['.ts', '.json'] },
    {
      id: 'lint-disable',
      pattern: 'eslint-disable',
      extensions: ['.ts'],
      allowedControls: [{ id: 'documented', pattern: 'convention\\s*:\\s*allow\\b.*(?:reason|because|--)' }],
    },
    { id: 'coverage-ignore', pattern: 'c8\\s+ignore', extensions: ['.ts'] },
    { id: 'unexplained-ignore', pattern: 'ignore', extensions: ['.ts'] },
  ],
}));

function fixture(body: string, extension = 'test.ts'): string {
  const root = mkdtempSync(join('/tmp', 'convention-policy-'));
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'test', extension), body);
  return root;
}

test('convention policy catches focus/skip syntax with arbitrary whitespace', () => {
  const root = fixture('test . only ("focused", () => {});\ndescribe.   skip ("x", () => {});\nit.\n  skip ("multiline", () => {});\n');
  try {
    const result = checkConvention(root, POLICY);
    assert.equal(result.pass, false);
    assert.equal(result.violations.filter((v) => v.ruleId === 'focus-skip').length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured bypass and unexplained-ignore syntax fail, documented controls pass', () => {
  const root = fixture([
    '// @ts-ignore',
    '// eslint-disable-next-line no-explicit-any',
    '/* c8 ignore next */',
    '// ignore this line',
    '// eslint-disable-next-line no-explicit-any // convention: allow documented -- fixture intentionally covers syntax',
  ].join('\n'));
  try {
    const result = checkConvention(root, POLICY);
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => v.ruleId === 'typecheck-bypass'));
    assert.ok(result.violations.some((v) => v.ruleId === 'lint-disable'));
    assert.ok(result.violations.some((v) => v.ruleId === 'coverage-ignore'));
    assert.ok(result.violations.some((v) => v.ruleId === 'unexplained-ignore'));
    assert.equal(
      result.violations.filter((v) => v.line === 6 && v.ruleId === 'lint-disable').length,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a control documented for one rule cannot waive a different rule', () => {
  const root = fixture([
    '// @ts-ignore // convention: allow documented -- only lint syntax is allowed',
  ].join('\n'));
  try {
    const result = checkConvention(root, POLICY);
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => v.ruleId === 'typecheck-bypass'));
    assert.ok(result.violations.some((v) => v.ruleId === 'unexplained-ignore'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy global allowedControls are rejected instead of widening every rule', () => {
  assert.throws(
    () => parseConventionPolicy(JSON.stringify({
      version: 1,
      roots: ['test'],
      rules: [{ id: 'focus', pattern: '\\.(?:only|skip)' }],
      allowedControls: [{ id: 'global', pattern: 'reason:' }],
    })),
    (error: unknown) => error instanceof ConventionPolicyError,
  );
});
