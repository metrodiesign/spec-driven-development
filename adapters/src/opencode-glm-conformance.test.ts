// opencode-glm conformance (spec: .ai/specs/opencode-glm REQ-4): the fifth
// lineage passes the SAME P1-P8 gate as every other adapter (INV-8), and the
// discrimination self-test extends to it — a prose-only fake exec fails
// EXACTLY P2. A regressed re-run marks the registered adapter stale.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createReasoningCliAdapter,
  type ReasoningCliExec,
} from './reasoning-cli.ts';
import {
  createRegistry,
  runConformanceSuite,
  runProbe,
  PASS_FAIL_PROBES,
  type ConformanceRecord,
  type ProbeContext,
} from 'aal';

const RESULT_USAGE = { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 };

/**
 * A fake ReasoningCliExec that reads the probe directive from the prompt (the
 * objective the harness embeds) and returns a probe-appropriate structured
 * message — mirroring how a compliant model behaves through the opencode JSONL
 * stream. `prose_only` sabotages ONLY P2 (empty proposal).
 */
function directiveExec(mode: 'compliant' | 'prose_only'): ReasoningCliExec {
  return ({ prompt }) => {
    const m = /\[probe:(\w+)([^\]]*)\]/.exec(prompt);
    const probe = m?.[1] ?? 'none';
    const rest = m?.[2] ?? '';
    const echo = /echo=([^\s\]]+)/.exec(rest)?.[1];
    const tool = /tool=([^\s\]]+)/.exec(rest)?.[1];

    let sr: Record<string, unknown> = {
      claim: 'READY_FOR_VERIFICATION',
      summary: 'proposed fix',
      actionRequests: [{ type: 'WRITE_FILE', path: 'src/impl.txt', content: 'correct\n' }],
    };
    if (echo !== undefined) sr = { ...sr, echo };
    if (probe === 'P5' && tool !== undefined) {
      sr = { claim: 'WORKING', actionRequests: [{ type: 'REQUEST_TOOL', name: tool }] };
    }
    if (mode === 'prose_only' && probe === 'P2') {
      sr = { prose: 'here is what I would do, in words' }; // no actionRequests -> fails P2
    }
    return Promise.resolve({
      exitCode: 0,
      responseText: JSON.stringify(sr),
      transcript: '',
      stderr: '',
      usage: RESULT_USAGE,
      toolUseCount: 0,
    });
  };
}

function memCtx(): ProbeContext {
  let n = 0;
  return { put: () => `blob://${n++}` };
}

function glmFor(exec: ReasoningCliExec) {
  const root = mkdtempSync(join(tmpdir(), 'ocglm-conf-'));
  const adapter = createReasoningCliAdapter({
    id: 'opencode-glm',
    lineage: 'zai',
    model: 'opencode-go/glm-5.3',
    contextWindowTokens: 1_000_000,
    exec,
    cwd: root,
    replayDir: join(root, 'replay'),
    putEvidence: () => 'blob://tr',
  });
  return { adapter, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('conformance P1-P8 all pass for the opencode-glm adapter on a compliant fake exec (REQ-4.1)', async () => {
  const c = glmFor(directiveExec('compliant'));
  try {
    const rec = await runConformanceSuite(c.adapter, memCtx(), '2026-08-16T00:00:00Z');
    assert.equal(rec.adapterId, 'opencode-glm');
    assert.equal(rec.modelVersion, 'opencode-go/glm-5.3');
    for (const p of rec.probes) assert.equal(p.pass, true, `${p.id} should pass (${p.detail ?? ''})`);
    assert.equal(rec.p7.susceptibilityScore, 0, 'compliant adapter does not leak the injection canary');
  } finally { c.cleanup(); }
});

test('a prose-only fake exec fails EXACTLY P2 (discrimination self-test, REQ-4.2)', async () => {
  const c = glmFor(directiveExec('prose_only'));
  try {
    for (const id of PASS_FAIL_PROBES) {
      const v = await runProbe(id, c.adapter, memCtx());
      if (id === 'P2') assert.equal(v.pass, false, 'prose-only must fail P2');
      else assert.equal(v.pass, true, `prose-only must NOT fail ${id} (${v.detail ?? ''})`);
    }
  } finally { c.cleanup(); }
});

test('a regressed opencode-glm conformance re-run marks the registered adapter stale (REQ-4.3)', async () => {
  const c = glmFor(directiveExec('compliant'));
  try {
    const good = await runConformanceSuite(c.adapter, memCtx(), '2026-08-16T00:00:00Z');
    const reg = createRegistry();
    reg.register(c.adapter, good);
    assert.equal(reg.get('opencode-glm')?.stale, false);
    // A later re-run that regresses a probe (drift canary) -> stale via existing registry semantics.
    const regressed: ConformanceRecord = {
      ...good,
      probes: good.probes.map((p) => (p.id === 'P2' ? { ...p, pass: false } : p)),
    };
    reg.recordConformance('opencode-glm', regressed);
    assert.equal(reg.get('opencode-glm')?.stale, true);
    assert.equal(reg.eligible('implementer').length, 0, 'stale opencode-glm adapter is not eligible');
  } finally { c.cleanup(); }
});
