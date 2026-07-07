// RED in task 4 (scanForSecret throws NotImplemented) -> GREEN same task.
// Generic secret shapes must be caught; ordinary code must NOT false-positive.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanForSecret } from './secret-scan.ts';

test('detects key/token shapes (runtime-assembled so the repo scanner stays quiet)', () => {
  const apiKey = ['sk', 'live', 'ABCDEFGH1234567890abcdefgh'].join('_');
  const gh = 'ghp'.concat('_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const aws = 'AKIA'.concat('ABCDEFGHIJKLMNOP');
  assert.equal(scanForSecret(`const k = "${apiKey}";`).hit, true);
  assert.equal(scanForSecret(`token=${gh}`).hit, true);
  assert.equal(scanForSecret(`aws=${aws}`).hit, true);
  // Assemble the PEM header at runtime so the repo's own secret guard (which
  // scans staged source) finds no contiguous key block in this test's bytes.
  const pem = '-----BEGIN '.concat('PRIVATE KEY-----\nMIIabc\n');
  assert.equal(scanForSecret(pem).hit, true);
});

test('high-entropy blob is flagged; ordinary prose/code is not', () => {
  const blob = 'X9f2Kd7Qp1Lm4Rt8Zx3Vb6Nc0Ws5Ey';
  assert.equal(scanForSecret(`secret: ${blob}`).hit, true);
  assert.equal(scanForSecret('function add(a, b) { return a + b; }').hit, false);
  assert.equal(scanForSecret('the quick brown fox jumps over the lazy dog').hit, false);
});
