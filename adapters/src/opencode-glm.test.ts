// opencode-glm lane unit tests (spec: .ai/specs/opencode-glm REQ-1..REQ-3).
// Hermetic: no `opencode` spawn ever happens — the observable child is a stub
// /bin/sh script of our own that records argv + in-sandbox facts, then exits.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AdapterError } from 'aal';

import {
  buildOpenCodeGlmEnv,
  buildOpenCodeReviewArgv,
  createLiveOpenCodeGlmAdapter,
  OPENCODE_GLM_DEFAULT_MODEL,
  opencodeErrorDetail,
  resolveOpenCodeAuthStore,
  resolveOpenCodeModelCatalog,
} from './reasoning-cli-live.ts';

const SANDBOX_PREFIX = 'platform-opencode-glm-';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** A data dir holding an opencode auth store, as `opencode auth login` leaves it. */
function fakeAuthData(): string {
  const root = tempDir('ocglm-auth');
  mkdirSync(join(root, 'opencode'), { recursive: true });
  writeFileSync(join(root, 'opencode', 'auth.json'), '{"opencode-go":{"type":"api","key":"redacted"}}');
  return root;
}

function req(requestId: string) {
  return {
    requestId,
    agentRole: 'implementer' as const,
    taskContract: { goalId: 'G-1', title: 'test goal', objective: 'do the thing', acceptanceCriteria: [] },
    contextBundle: { pieces: [], canaryToken: 'CANARY-TEST', stats: { bytes: 0, pieceCount: 0 } },
    manifestRef: 'blob://m',
    outputSchema: { type: 'object' as const },
    toolDefs: [],
    budget: { costUnits: 4 },
  };
}

/**
 * A stub binary that records three single-line facts into `capture` — (1) its argv
 * with newlines squashed (the prompt is multi-line), (2) the auth copy's mode via
 * `ls` (portable across BSD/GNU), (3) the child's $HOME — then prints one JSONL
 * event carrying a compliant structured response.
 */
function stubBinary(capture: string): string {
  const dir = tempDir('ocglm-bin');
  const path = join(dir, 'stub.sh');
  const script = [
    '#!/bin/sh',
    `{ printf '%s\\n' "$@" | tr '\\n' ' '; echo; ls -l "$HOME/data/opencode/auth.json" | awk '{print $1}'; echo "$HOME"; } > ${JSON.stringify(capture)}`,
    `echo '{"type":"text","text":"{\\"claim\\":\\"READY_FOR_VERIFICATION\\",\\"actionRequests\\":[]}"}'`,
  ].join('\n');
  writeFileSync(path, script, { mode: 0o755 });
  return path;
}

function captureLines(capture: string): string[] {
  return readFileSync(capture, 'utf8').trim().split('\n');
}

test('argv shape: buildOpenCodeReviewArgv with the glm default model (REQ-1.1/4.4)', () => {
  const argv = buildOpenCodeReviewArgv('PROMPT', OPENCODE_GLM_DEFAULT_MODEL);
  assert.deepEqual(argv, ['run', '--pure', '--format', 'json', '--model', 'opencode-go/glm-5.3', 'PROMPT']);
});

test('manifest: opencode-glm / zai lineage / 1M window (REQ-1.2)', () => {
  const adapter = createLiveOpenCodeGlmAdapter({
    authDataDir: fakeAuthData(),
    binary: '/bin/true',
    cwd: tempDir('ocglm-cwd'),
    replayDir: tempDir('ocglm-replay'),
    putEvidence: () => 'blob://tr',
  });
  const m = adapter.manifest();
  assert.equal(m.adapterId, 'opencode-glm');
  assert.equal(m.lineage, 'zai');
  assert.equal(m.contextWindowTokens, 1_000_000);
  assert.equal(m.executionBackend, false);
  assert.equal(m.structuredOutput, true);
  assert.equal(m.toolCalling, false);
  assert.equal(m.determinism, 'none');
});

test('model override flows to the spawned argv (REQ-1.4)', async () => {
  const capture = join(tempDir('ocglm-cap'), 'argv.txt');
  const adapter = createLiveOpenCodeGlmAdapter({
    authDataDir: fakeAuthData(),
    binary: stubBinary(capture),
    model: 'opencode-go/glm-5.9',
    cwd: tempDir('ocglm-cwd'),
    replayDir: tempDir('ocglm-replay'),
    putEvidence: () => 'blob://tr',
  });
  const res = await adapter.send(req('model-override-1'));
  assert.equal(res.adapterMeta.modelVersion, 'opencode-go/glm-5.9');
  const argv = captureLines(capture)[0]?.split(' ') ?? [];
  assert.equal(argv[argv.indexOf('--model') + 1] ?? '', 'opencode-go/glm-5.9');
});

test('sandbox: auth copy present owner-only inside sandbox, sandbox HOME isolated and destroyed (REQ-2.1/2.2/2.4)', async () => {
  const capture = join(tempDir('ocglm-cap'), 'facts.txt');
  const staleBefore = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith(SANDBOX_PREFIX)));
  const adapter = createLiveOpenCodeGlmAdapter({
    authDataDir: fakeAuthData(),
    binary: stubBinary(capture),
    cwd: tempDir('ocglm-cwd'),
    replayDir: tempDir('ocglm-replay'),
    putEvidence: () => 'blob://tr',
  });
  const res = await adapter.send(req('sandbox-1'));
  assert.equal(res.adapterMeta.adapterId, 'opencode-glm');
  const lines = captureLines(capture);
  const authMode = lines[1] ?? '';
  const childHome = lines[2] ?? '';
  assert.match(authMode, /^-rw-------/, `auth copy must be owner-only (0600), got ${authMode}`);
  assert.ok(childHome.includes(SANDBOX_PREFIX), `child HOME must be the sandbox root, got ${childHome}`);
  // REQ-2.4: the per-invocation sandbox (and its credential copy) is gone — no NEW dirs.
  const after = readdirSync(tmpdir()).filter((d) => d.startsWith(SANDBOX_PREFIX) && !staleBefore.has(d));
  assert.deepEqual(after, [], `sandbox dirs must be cleaned up, saw ${after}`);
});

test('resolveOpenCodeAuthStore: path when present, null when absent (REQ-2.2/2.3)', () => {
  const withStore = fakeAuthData();
  assert.equal(resolveOpenCodeAuthStore(withStore), join(withStore, 'opencode', 'auth.json'));
  const without = tempDir('ocglm-empty');
  assert.equal(resolveOpenCodeAuthStore(without), null);
});

test('buildOpenCodeGlmEnv: everything under the sandbox root, deny-all config, no foreign keys (REQ-2.1/2.2)', () => {
  const root = tempDir('ocglm-root');
  const env = buildOpenCodeGlmEnv(root, { HOME: '/real/home', XDG_DATA_HOME: '/real/share', SECRET_LEAK: 'x', PATH: '/usr/bin' });
  assert.equal(env['HOME'], root);
  assert.equal(env['XDG_DATA_HOME'], join(root, 'data'));
  assert.equal(env['XDG_CONFIG_HOME'], join(root, 'config'));
  assert.equal(env['XDG_CACHE_HOME'], join(root, 'cache'));
  assert.equal(env['OPENCODE_CONFIG_DIR'], join(root, 'config'));
  assert.equal(env['OPENCODE_DISABLE_AUTOUPDATE'], 'true');
  const cfg = JSON.parse(env['OPENCODE_CONFIG_CONTENT'] as string) as Record<string, unknown>;
  assert.equal(cfg['permission'], 'deny');
  assert.equal(cfg['autoupdate'], false);
  assert.equal(env['SECRET_LEAK'], undefined, 'non-allowlisted source keys must not cross');
  assert.equal(env['PATH'], '/usr/bin', 'safe runtime keys survive');
});

test('fail-fast: missing auth store throws auth_unavailable at construction (REQ-2.3)', () => {
  assert.throws(
    () =>
      createLiveOpenCodeGlmAdapter({
        authDataDir: tempDir('ocglm-empty'),
        binary: '/bin/true',
        cwd: tempDir('ocglm-cwd'),
        replayDir: tempDir('ocglm-replay'),
        putEvidence: () => 'blob://tr',
      }),
    (err: unknown) => err instanceof AdapterError && err.kind === 'auth_unavailable',
  );
});

test('credential hygiene: store content never reaches evidence or replay (REQ-2.5)', async () => {
  const dataDir = fakeAuthData();
  const secretMarker = 'REDACTED-KEY-MATERIAL';
  writeFileSync(join(dataDir, 'opencode', 'auth.json'), `{"k":"${secretMarker}"}`);
  const seen: string[] = [];
  const replayDir = tempDir('ocglm-replay');
  const capture = join(tempDir('ocglm-cap'), 'argv.txt');
  const adapter = createLiveOpenCodeGlmAdapter({
    authDataDir: dataDir,
    binary: stubBinary(capture),
    cwd: tempDir('ocglm-cwd'),
    replayDir,
    putEvidence: (s) => (seen.push(s), 'blob://e'),
  });
  await adapter.send(req('hygiene-1'));
  const replayFiles = readdirSync(replayDir).map((f) => readFileSync(join(replayDir, f), 'utf8'));
  const allDurable = [...seen, ...replayFiles].join('\n');
  assert.ok(!allDurable.includes(secretMarker), 'evidence/replay must not contain credential content');
});

test('resolveOpenCodeModelCatalog: path when present, null when absent', () => {
  const cache = tempDir('ocglm-cache');
  mkdirSync(join(cache, 'opencode'), { recursive: true });
  writeFileSync(join(cache, 'opencode', 'models.json'), '{"opencode-go":{}}');
  assert.equal(resolveOpenCodeModelCatalog(cache), join(cache, 'opencode', 'models.json'));
  assert.equal(resolveOpenCodeModelCatalog(tempDir('ocglm-empty')), null);
});

test('sandbox: model catalog seeded from cacheDir when present, run fine without when absent', async () => {
  const cache = tempDir('ocglm-cache');
  mkdirSync(join(cache, 'opencode'), { recursive: true });
  writeFileSync(join(cache, 'opencode', 'models.json'), '{"catalog":"seed"}');
  const capture = join(tempDir('ocglm-cap'), 'facts.txt');
  const bin = join(tempDir('ocglm-bin'), 'probe.sh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `{ if [ -f "$XDG_CACHE_HOME/opencode/models.json" ]; then echo catalog-yes; else echo catalog-no; fi; } > ${JSON.stringify(capture)}`,
      `echo '{"type":"text","text":"{\\"claim\\":\\"WORKING\\",\\"actionRequests\\":[]}"}'`,
    ].join('\n'),
    { mode: 0o755 },
  );
  const withCatalog = createLiveOpenCodeGlmAdapter({
    authDataDir: fakeAuthData(),
    cacheDir: cache,
    binary: bin,
    cwd: tempDir('ocglm-cwd'),
    replayDir: tempDir('ocglm-replay'),
    putEvidence: () => 'blob://tr',
  });
  await withCatalog.send(req('catalog-1'));
  assert.equal(readFileSync(capture, 'utf8').trim(), 'catalog-yes');
  // Best-effort: absent catalog does not break the invocation (cold-start race returns).
  const withoutCatalog = createLiveOpenCodeGlmAdapter({
    authDataDir: fakeAuthData(),
    cacheDir: tempDir('ocglm-empty'),
    binary: bin,
    cwd: tempDir('ocglm-cwd'),
    replayDir: tempDir('ocglm-replay'),
    putEvidence: () => 'blob://tr',
  });
  await withoutCatalog.send(req('catalog-2'));
  assert.equal(readFileSync(capture, 'utf8').trim(), 'catalog-no');
});

// Keep the shared tmpdir from accumulating this suite's scratch dirs across runs.
test('scratch cleanup', () => {
  for (const d of readdirSync(tmpdir())) {
    if (/^(ocglm-|platform-opencode-glm-)/.test(d)) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
});

test('opencodeErrorDetail: stdout error events extracted, ref included, none -> null', () => {
  const stdout = [
    '{"type":"step_start","part":{"type":"step-start"}}',
    '{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_63ff0ccd"}}}',
  ].join('\n');
  assert.equal(
    opencodeErrorDetail(stdout),
    'UnknownError: Unexpected server error. Check server logs for details. (ref err_63ff0ccd)',
  );
  assert.equal(opencodeErrorDetail('{"type":"text","text":"ok"}'), null);
  assert.equal(opencodeErrorDetail(''), null);
  // Malformed error event (no name/message) -> null, never a blank detail.
  assert.equal(opencodeErrorDetail('{"type":"error","error":{}}'), null);
});

test('a failing opencode run surfaces the stdout error event in the thrown AdapterError detail', async () => {
  // Stub child that mimics the real failure shape: error event on STDOUT, exit 1,
  // EMPTY stderr — the exact live signature observed on the OpenCode Go gateway.
  const dir = tempDir('ocglm-bin');
  const bin = join(dir, 'fail.sh');
  writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `echo '{"type":"error","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_deadbeef"}}}'`,
      'exit 1',
    ].join('\n'),
    { mode: 0o755 },
  );
  const adapter = createLiveOpenCodeGlmAdapter({
    authDataDir: fakeAuthData(),
    binary: bin,
    cwd: tempDir('ocglm-cwd'),
    replayDir: tempDir('ocglm-replay'),
    putEvidence: () => 'blob://tr',
  });
  await assert.rejects(
    adapter.send(req('fail-1')),
    (err: unknown) =>
      err instanceof AdapterError &&
      err.kind === 'transport' &&
      (err.message.includes('Unexpected server error') ?? false) &&
      (err.message.includes('err_deadbeef') ?? false),
  );
});
