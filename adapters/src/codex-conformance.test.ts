// Codex conformance (REQ-3): the second adapter passes the SAME P1-P8 gate as the
// first (INV-8), and the discrimination self-test extends to it — a prose-only fake
// ExecFn fails EXACTLY P2. A regressed re-run marks the registered adapter stale.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createCodexAdapter, type CodexEvent, type ExecFn } from './codex.ts';
import {
  createRegistry,
  runConformanceSuite,
  runProbe,
  PASS_FAIL_PROBES,
  type ConformanceRecord,
  type ProbeContext,
} from 'aal';

const EVENTS: CodexEvent[] = [{ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 2 } }];

/**
 * A fake ExecFn that reads the probe directive from the prompt (the objective the
 * harness embeds) and returns a probe-appropriate structured message — mirroring how a
 * compliant model would behave. `prose_only` sabotages ONLY P2 (empty proposal).
 */
function directiveExec(mode: 'compliant' | 'prose_only'): ExecFn {
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
    return Promise.resolve({ exitCode: 0, lastMessage: JSON.stringify(sr), events: EVENTS, stderr: '' });
  };
}

function memCtx(): ProbeContext {
  let n = 0;
  return { put: () => `blob://${n++}` };
}

function codexFor(exec: ExecFn) {
  const root = mkdtempSync(join(tmpdir(), 'codex-conf-'));
  const adapter = createCodexAdapter({
    id: 'codex',
    model: 'gpt-x',
    exec,
    cwd: root,
    replayDir: join(root, 'replay'),
    putEvidence: () => 'blob://tr',
  });
  return { adapter, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('conformance P1-P8 all pass for the codex adapter on a compliant fake ExecFn (REQ-3.1)', async () => {
  const c = codexFor(directiveExec('compliant'));
  try {
    const rec = await runConformanceSuite(c.adapter, memCtx(), '2026-07-08T00:00:00Z');
    assert.equal(rec.adapterId, 'codex');
    assert.equal(rec.modelVersion, 'gpt-x');
    for (const p of rec.probes) assert.equal(p.pass, true, `${p.id} should pass (${p.detail ?? ''})`);
    assert.equal(rec.p7.susceptibilityScore, 0, 'compliant adapter does not leak the injection canary');
  } finally { c.cleanup(); }
});

test('a prose-only fake ExecFn fails EXACTLY P2 (discrimination self-test extended, REQ-3.2)', async () => {
  const c = codexFor(directiveExec('prose_only'));
  try {
    for (const id of PASS_FAIL_PROBES) {
      const v = await runProbe(id, c.adapter, memCtx());
      if (id === 'P2') assert.equal(v.pass, false, 'prose-only must fail P2');
      else assert.equal(v.pass, true, `prose-only must NOT fail ${id} (${v.detail ?? ''})`);
    }
  } finally { c.cleanup(); }
});

test('a regressed codex conformance re-run marks the registered adapter stale (REQ-3.4)', async () => {
  const c = codexFor(directiveExec('compliant'));
  try {
    const good = await runConformanceSuite(c.adapter, memCtx(), '2026-07-08T00:00:00Z');
    const reg = createRegistry();
    reg.register(c.adapter, good);
    assert.equal(reg.get('codex')?.stale, false);
    // A later re-run that regresses a probe (drift canary) -> stale via existing registry semantics.
    const regressed: ConformanceRecord = {
      ...good,
      probes: good.probes.map((p) => (p.id === 'P2' ? { ...p, pass: false } : p)),
    };
    reg.recordConformance('codex', regressed);
    assert.equal(reg.get('codex')?.stale, true);
    assert.equal(reg.eligible('implementer').length, 0, 'stale codex adapter is not eligible');
  } finally { c.cleanup(); }
});
