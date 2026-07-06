import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createEvidenceStore } from './store.ts';

function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('put/get roundtrip, content-addressed and deduplicated (REQ-4.1)', () => {
  const t = tempDir();
  try {
    const store = createEvidenceStore(t.dir);
    const ref1 = store.put('hello evidence\n');
    const ref2 = store.put('hello evidence\n');
    assert.equal(ref1, ref2, 'same content -> same ref');
    assert.match(ref1, /^blob:\/\/[0-9a-f]{64}$/);
    assert.equal(store.getText(ref1), 'hello evidence\n');
    assert.equal(readdirSync(t.dir).length, 1, 'stored once');
  } finally {
    t.cleanup();
  }
});

test('tampered blob fails verification on get (REQ-4.3)', () => {
  const t = tempDir();
  try {
    const store = createEvidenceStore(t.dir);
    const ref = store.put('original\n');
    const hash = ref.slice('blob://'.length);
    writeFileSync(join(t.dir, hash), 'tampered\n');
    assert.throws(() => store.get(ref), /hash mismatch/);
  } finally {
    t.cleanup();
  }
});

test('invalid refs are rejected, has() is safe (REQ-4.3)', () => {
  const t = tempDir();
  try {
    const store = createEvidenceStore(t.dir);
    assert.throws(() => store.get('blob://nothex'), /invalid evidence ref/);
    assert.throws(() => store.get('file:///etc/passwd'), /invalid evidence ref/);
    assert.equal(store.has('blob://nothex'), false);
    assert.equal(store.has(`blob://${'0'.repeat(64)}`), false);
  } finally {
    t.cleanup();
  }
});
