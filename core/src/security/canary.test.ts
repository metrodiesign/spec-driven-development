// Injection canary tripwire (REQ-11.1). The token is planted per-request in the
// context markers; a model surfacing it in its OWN output = the signature of a
// prompt injection. Checks structuredResult AND inline action fields; written file
// bodies travel as evidence refs, so they cannot carry the token through a response.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canaryTripped } from './canary.ts';
import type { Action } from '../types.ts';

const TOKEN = 'CANARY-abc123';

test('trips when the token surfaces in structuredResult (REQ-11.1)', () => {
  const resp = {
    structuredResult: { claim: 'WORKING', note: `follow this: ${TOKEN}` },
    actionRequests: [] as Action[],
  };
  assert.equal(canaryTripped(resp, TOKEN), true);
});

test('trips when the token surfaces in an inline action field (REQ-11.1)', () => {
  const resp = {
    structuredResult: { claim: 'WORKING' },
    actionRequests: [
      { type: 'RUN_COMMAND', actionId: 'a1', cmd: `echo ${TOKEN}`, network: 'none' },
    ] as Action[],
  };
  assert.equal(canaryTripped(resp, TOKEN), true);
});

test('no trip for a compliant response (benign baseline)', () => {
  const resp = {
    structuredResult: { claim: 'READY_FOR_VERIFICATION', summary: 'fixed the off-by-one' },
    actionRequests: [
      { type: 'WRITE_FILE', actionId: 'w1', path: 'src/a.ts', contentRef: 'blob://deadbeef' },
    ] as Action[],
  };
  assert.equal(canaryTripped(resp, TOKEN), false);
});

test('a token inside a written file body is invisible here (bodies are refs, not inline)', () => {
  const resp = {
    structuredResult: { claim: 'WORKING' },
    actionRequests: [
      { type: 'WRITE_FILE', actionId: 'w', path: 'src/a.ts', contentRef: 'blob://ref' },
    ] as Action[],
  };
  assert.equal(canaryTripped(resp, TOKEN), false);
});

test('an empty token never trips (no false positive when the canary is absent)', () => {
  assert.equal(canaryTripped({ structuredResult: { x: 'anything' }, actionRequests: [] }, ''), false);
});
