// Fusion resolve rules — adversarial, pure (REQ-10.1..10.6). The core guarantees:
// a gate-red candidate can never win code_diff/tests even if it is FIRST in the
// panel; a code_diff winner is exactly one candidate's actions (chimera ban); tests
// union+dedupe; hypotheses rank by probe count; reviews survive-if-any + escalation
// marker on disagreement + dissent for not-raised-by-all.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveCodeDiff, resolveTests, resolveHypotheses, resolveReviews, type PanelCandidate } from './resolve.ts';
import type { Action, GateReport } from 'core';

function gate(pass: boolean): GateReport {
  return { tier: 'T1', pass, gateConfigHash: 'h', commitHash: 'c', worktreeHash: 'w', envHash: 'e', checks: [], scopeNote: '' };
}

function write(path: string, ref: string): Action {
  return { type: 'WRITE_FILE', actionId: `a-${path}-${ref}`, path, contentRef: ref };
}

function candidate(over: Partial<PanelCandidate> & { index: number }): PanelCandidate {
  return {
    requestId: `req-${over.index}`,
    adapterId: `adp-${over.index}`,
    lineage: 'familyA',
    structuredResult: {},
    actions: [],
    usage: { costUnits: 1 },
    ...over,
  };
}

test('code_diff: a gate-red candidate that is FIRST in the panel can never win (REQ-10.1)', () => {
  const red = candidate({ index: 0, actions: [write('a.ts', 'blob://red')], gate: gate(false) });
  const green = candidate({ index: 1, actions: [write('a.ts', 'blob://green')], gate: gate(true) });
  const res = resolveCodeDiff([red, green]);
  assert.deepEqual(res.winner?.actions, green.actions, 'winner must be the gate-green candidate, not the first');
});

test('code_diff: the winner is exactly one candidate actions — never a synthesis/merge (REQ-10.2)', () => {
  const c0 = candidate({ index: 0, actions: [write('a.ts', 'blob://0')], gate: gate(true) });
  const c1 = candidate({ index: 1, actions: [write('b.ts', 'blob://1')], gate: gate(true) });
  const res = resolveCodeDiff([c0, c1]);
  // Deep-equal to ONE candidate's action array — not a concatenation of both.
  assert.deepEqual(res.winner?.actions, c0.actions);
  assert.equal(res.winner?.actions.length, 1, 'never a merged action set');
});

test('code_diff: all candidates gate-red -> no winner, escalate no_gate_survivor', () => {
  const res = resolveCodeDiff([
    candidate({ index: 0, gate: gate(false) }),
    candidate({ index: 1, gate: gate(false) }),
  ]);
  assert.equal(res.winner, null);
  assert.equal(res.escalateReason, 'no_gate_survivor');
});

test('tests: union across gate-green candidates, deduped by path, each RED-check flagged (REQ-10.3)', () => {
  const c0 = candidate({ index: 0, gate: gate(true), actions: [write('t/a.test.ts', 'blob://a'), write('t/shared.test.ts', 'blob://s0')] });
  const c1 = candidate({ index: 1, gate: gate(true), actions: [write('t/b.test.ts', 'blob://b'), write('t/shared.test.ts', 'blob://s1')] });
  const res = resolveTests([c0, c1]);
  const paths = res.winner?.actions.map((a) => (a.type === 'WRITE_FILE' ? a.path : '')).sort();
  assert.deepEqual(paths, ['t/a.test.ts', 't/b.test.ts', 't/shared.test.ts'], 'union deduped by path (shared kept once)');
  const tests = (res.winner?.structuredResult as { tests: { path: string; redCheckRequired: boolean }[] }).tests;
  assert.ok(tests.every((t) => t.redCheckRequired === true), 'every unioned test flagged for RED-check');
});

test('tests: a gate-red candidate is excluded from the union (REQ-10.1 applies to tests too)', () => {
  const red = candidate({ index: 0, gate: gate(false), actions: [write('t/red.test.ts', 'blob://r')] });
  const green = candidate({ index: 1, gate: gate(true), actions: [write('t/green.test.ts', 'blob://g')] });
  const res = resolveTests([red, green]);
  const paths = res.winner?.actions.map((a) => (a.type === 'WRITE_FILE' ? a.path : ''));
  assert.deepEqual(paths, ['t/green.test.ts']);
});

test('hypotheses: union deduped by statement, ranked by probe count ascending (REQ-10.4)', () => {
  const c0 = candidate({ index: 0, structuredResult: { hypotheses: [
    { statement: 'H-big', probes: [1, 2, 3] },
    { statement: 'H-dup', probes: [1] },
  ] } });
  const c1 = candidate({ index: 1, structuredResult: { hypotheses: [
    { statement: 'H-small', probes: [1] },
    { statement: 'H-dup', probes: [1, 2] }, // duplicate statement -> first wins
  ] } });
  const res = resolveHypotheses([c0, c1]);
  const hyps = (res.winner?.structuredResult as { hypotheses: { statement: string; probes: unknown[] }[] }).hypotheses;
  assert.deepEqual(hyps.map((h) => h.statement), ['H-dup', 'H-small', 'H-big'], 'ranked ascending by probe count; dup deduped');
});

test('reviews: a finding survives if ANY candidate raises it; not-raised-by-all is dissent (REQ-10.5/10.6)', () => {
  const c0 = candidate({ index: 0, structuredResult: { findings: [{ id: 'F1', severity: 'high', blocking: true }, { id: 'F2', severity: 'low', blocking: false }] } });
  const c1 = candidate({ index: 1, structuredResult: { findings: [{ id: 'F1', severity: 'high', blocking: true }] } });
  const res = resolveReviews([c0, c1]);
  const findings = (res.winner?.structuredResult as { findings: { key: string }[] }).findings.map((f) => f.key).sort();
  assert.deepEqual(findings, ['F1', 'F2'], 'both findings survive (F2 raised by only one)');
  assert.deepEqual(res.dissent.map((d) => d.finding), ['F2'], 'F2 (not raised by all) captured as dissent');
});

test('reviews: candidates disagreeing on severity/blocking raise the escalation marker (REQ-10.5)', () => {
  const c0 = candidate({ index: 0, structuredResult: { findings: [{ id: 'F1', severity: 'high', blocking: true }] } });
  const c1 = candidate({ index: 1, structuredResult: { findings: [{ id: 'F1', severity: 'low', blocking: false }] } });
  const res = resolveReviews([c0, c1]);
  assert.equal(res.escalationMarker, true, 'severity/blocking disagreement fires the escalation marker');
});
