import assert from 'node:assert/strict';
import { test } from 'node:test';

import { corsOriginAllowed, decideStartup, hostHeaderAllowed, redactText } from './security.ts';

test('startup gate: loopback starts, non-loopback refuses without provider (REQ-12.2)', () => {
  assert.deepEqual(decideStartup({ host: '127.0.0.1', insecure: false, hasAuthProvider: false }), {
    action: 'start',
  });
  assert.deepEqual(decideStartup({ host: 'localhost', insecure: false, hasAuthProvider: false }), {
    action: 'start',
  });
  const refused = decideStartup({ host: '0.0.0.0', insecure: false, hasAuthProvider: false });
  assert.equal(refused.action, 'refuse');
  if (refused.action === 'refuse') assert.match(refused.message, /fail-closed/);
});

test('startup gate: --insecure starts non-loopback WITH a loud warning (REQ-12.3)', () => {
  const d = decideStartup({ host: '0.0.0.0', insecure: true, hasAuthProvider: false });
  assert.equal(d.action, 'start_with_warning');
  if (d.action === 'start_with_warning') assert.match(d.warning, /INSECURE/);
});

test('host header allowlist: localhost forms + bind host + port pinning (REQ-12.4)', () => {
  assert.equal(hostHeaderAllowed('127.0.0.1:9119', '127.0.0.1', 9119), true);
  assert.equal(hostHeaderAllowed('localhost:9119', '127.0.0.1', 9119), true);
  assert.equal(hostHeaderAllowed('evil.example.com:9119', '127.0.0.1', 9119), false, 'DNS rebinding blocked');
  assert.equal(hostHeaderAllowed('127.0.0.1:9999', '127.0.0.1', 9119), false, 'wrong port blocked');
  assert.equal(hostHeaderAllowed(undefined, '127.0.0.1', 9119), false, 'missing header blocked');
  assert.equal(hostHeaderAllowed('192.168.1.5:9119', '192.168.1.5', 9119), true, 'bind host allowed');
});

test('CORS origin allowlist mirrors the host allowlist (REQ-12.4)', () => {
  assert.equal(corsOriginAllowed('http://localhost:9119', '127.0.0.1', 9119), true);
  assert.equal(corsOriginAllowed('http://evil.example.com', '127.0.0.1', 9119), false);
  assert.equal(corsOriginAllowed('not-a-url', '127.0.0.1', 9119), false);
});

test('redaction: tokens, credential paths, home prefix -> display form (REQ-12.5)', () => {
  const home = '/Users/operator';
  // Synthetic token SHAPES assembled at runtime so the repo's own secret
  // scanner (rightly) finds no literal key-like assignment in source.
  const fakeApiKey = ['sk', 'ant', 'abc123def456ghi789'].join('-');
  const fakeGhToken = 'ghp'.concat('_', 'abcdefghijklmnopqrstuvwxyz123456');
  const input = JSON.stringify({
    a: fakeApiKey,
    b: `${home}/.claude/.credentials.json`,
    c: `${home}/Desktop/project`,
    d: fakeGhToken,
  });
  const out = redactText(input, home);
  assert.ok(!out.includes(fakeApiKey), 'API-key shape redacted');
  assert.ok(!out.includes(fakeGhToken), 'token shape redacted');
  assert.ok(!out.includes('.credentials.json'), 'credential path redacted');
  assert.ok(out.includes('~/Desktop/project'), 'project path stays usable in ~ form');
  assert.ok(!out.includes(home), 'raw home prefix gone');
});
