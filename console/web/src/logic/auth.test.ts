import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interpretAuthProbe, interpretLoginResponse, interpretProviderProbe } from './auth.ts';

test('interpretAuthProbe: only 200 is authed; errors fail closed before protected reads (REQ-8.1)', () => {
  assert.equal(interpretAuthProbe(401), 'unauthed');
  assert.equal(interpretAuthProbe(200), 'authed');
  assert.equal(interpretAuthProbe(500), 'unauthed');
  assert.equal(interpretAuthProbe(204), 'unauthed');
});

test('interpretLoginResponse: 200 is ok; failure carries the generic error message (REQ-19.6)', () => {
  assert.deepEqual(interpretLoginResponse(200, {}), { ok: true });
  assert.deepEqual(interpretLoginResponse(401, { error: 'unauthorized' }), { ok: false, error: 'unauthorized' });
  assert.deepEqual(interpretLoginResponse(429, { error: 'too many attempts; try again later' }), {
    ok: false,
    error: 'too many attempts; try again later',
  });
});

test('interpretLoginResponse: missing error body still yields a display string', () => {
  const outcome = interpretLoginResponse(500, {});
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(outcome.error, /500/);
});

test('interpretProviderProbe: oidc kind renders the Google link; anything else defaults to the password form (REQ-20)', () => {
  assert.equal(interpretProviderProbe(200, { kind: 'oidc' }), 'oidc');
  assert.equal(interpretProviderProbe(200, { kind: 'basic' }), 'basic');
  assert.equal(interpretProviderProbe(200, {}), 'basic', 'malformed body degrades to basic, not a dead end');
  assert.equal(interpretProviderProbe(500, { kind: 'oidc' }), 'basic', 'non-200 degrades to basic');
});
