import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openFilePrGateArtifactSession } from './artifacts.ts';

test('signed PR gate artifacts recover and verify through existing Ed25519 run metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-artifacts-'));
  try {
    const created = openFilePrGateArtifactSession({ stateRoot: root, runId: 'RUN-1', recovering: false });
    const ref = created.put('report', { decision: 'PASS', count: 1 });
    assert.match(ref, /^sha256:[0-9a-f]{64}$/u);
    const recovered = openFilePrGateArtifactSession({ stateRoot: root, runId: 'RUN-1', recovering: true });
    assert.deepEqual(recovered.get(ref, 'report'), { decision: 'PASS', count: 1 });
    assert.throws(() => recovered.get(ref, 'wrong-kind'), /kind mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
