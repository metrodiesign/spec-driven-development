import assert from 'node:assert/strict';
import { test } from 'node:test';

import { corsOriginAllowed, decideStartup, hostHeaderAllowed, parseBehindProxy, redactText } from './security.ts';

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

test('startup gate: a real auth provider allows a non-loopback bind (REQ-19.1)', () => {
  assert.deepEqual(decideStartup({ host: '0.0.0.0', insecure: false, hasAuthProvider: true }), {
    action: 'start',
  });
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

test('CORS/host port pinning: a portless origin is port 80, NOT the console origin (REQ-12.4)', () => {
  // http://localhost (implicit :80) is a DIFFERENT origin from the console on
  // :9119 — a page served from another localhost server must not get CORS reads.
  assert.equal(corsOriginAllowed('http://localhost', '127.0.0.1', 9119), false);
  assert.equal(corsOriginAllowed('http://localhost:80', '127.0.0.1', 9119), false);
  assert.equal(corsOriginAllowed('https://localhost', '127.0.0.1', 9119), false);
  assert.equal(corsOriginAllowed('http://127.0.0.1', '127.0.0.1', 9119), false);
  // Default-port equivalence stays honest when the console itself runs on 80.
  assert.equal(corsOriginAllowed('http://localhost', '127.0.0.1', 80), true);
  // Host header without a port means port 80 as well — reject on 9119.
  assert.equal(hostHeaderAllowed('localhost', '127.0.0.1', 9119), false);
  assert.equal(hostHeaderAllowed('127.0.0.1', '127.0.0.1', 9119), false);
  assert.equal(hostHeaderAllowed('localhost', '127.0.0.1', 80), true);
});

test('startup gate: --behind-proxy forces the gate on over a loopback bind, ignoring --insecure (REQ-20.1)', () => {
  const noProvider = decideStartup({
    host: '127.0.0.1',
    insecure: false,
    hasAuthProvider: false,
    behindProxy: 'https://box.tailnet.ts.net',
  });
  assert.equal(noProvider.action, 'refuse');
  if (noProvider.action === 'refuse') assert.match(noProvider.message, /behind-proxy/);

  // "a proxy flag never weakens" — --insecure has no effect once behind-proxy is set.
  const insecureToo = decideStartup({
    host: '127.0.0.1',
    insecure: true,
    hasAuthProvider: false,
    behindProxy: 'https://box.tailnet.ts.net',
  });
  assert.equal(insecureToo.action, 'refuse', '--insecure must not bypass the forced gate');

  const withProvider = decideStartup({
    host: '127.0.0.1',
    insecure: false,
    hasAuthProvider: true,
    behindProxy: 'https://box.tailnet.ts.net',
  });
  assert.deepEqual(withProvider, { action: 'start' });
});

test('host header allowlist: the --behind-proxy public host is allowed at any port (REQ-20.2)', () => {
  assert.equal(hostHeaderAllowed('box.tailnet.ts.net', '127.0.0.1', 9119, 'box.tailnet.ts.net'), true);
  assert.equal(hostHeaderAllowed('box.tailnet.ts.net:443', '127.0.0.1', 9119, 'box.tailnet.ts.net'), true);
  assert.equal(hostHeaderAllowed('evil.example.com', '127.0.0.1', 9119, 'box.tailnet.ts.net'), false);
  // Absent proxyHost: unchanged behavior (regression guard).
  assert.equal(hostHeaderAllowed('box.tailnet.ts.net', '127.0.0.1', 9119), false);
});

test('host header allowlist: a --behind-proxy URL naming its OWN non-default port still matches (Codex review, PR #47)', () => {
  // --behind-proxy https://box.tailnet.ts.net:8443 -> parseBehindProxy's `host` keeps
  // the port; the incoming Host header (any port, per REQ-20.2) must still match on
  // hostname alone, not fail because proxyHost's raw string still carries ":8443".
  assert.equal(hostHeaderAllowed('box.tailnet.ts.net:8443', '127.0.0.1', 9119, 'box.tailnet.ts.net:8443'), true);
  assert.equal(hostHeaderAllowed('box.tailnet.ts.net', '127.0.0.1', 9119, 'box.tailnet.ts.net:8443'), true);
  assert.equal(hostHeaderAllowed('box.tailnet.ts.net:1234', '127.0.0.1', 9119, 'box.tailnet.ts.net:8443'), true);
});

test('CORS origin allowlist also honors the --behind-proxy host (REQ-20.2)', () => {
  assert.equal(corsOriginAllowed('https://box.tailnet.ts.net', '127.0.0.1', 9119, 'box.tailnet.ts.net'), true);
  assert.equal(corsOriginAllowed('https://evil.example.com', '127.0.0.1', 9119, 'box.tailnet.ts.net'), false);
});

test('parseBehindProxy: accepts https, normalizes to origin form, rejects non-https/malformed (REQ-20.2)', () => {
  assert.deepEqual(parseBehindProxy('https://box.tailnet.ts.net'), {
    origin: 'https://box.tailnet.ts.net',
    host: 'box.tailnet.ts.net',
  });
  assert.deepEqual(parseBehindProxy('https://box.tailnet.ts.net/some/path?x=1'), {
    origin: 'https://box.tailnet.ts.net',
    host: 'box.tailnet.ts.net',
  });
  assert.equal(parseBehindProxy('http://box.tailnet.ts.net'), null, 'plain http rejected');
  assert.equal(parseBehindProxy('not-a-url'), null);
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
