import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { createEvidenceStore } from '../evidence/store.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { createCommandRunner } from './command-runner.ts';
import { denyNetworkSandbox, type SandboxWrap } from './sandbox.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'command-runner-'));
  const evidence = createEvidenceStore(join(root, 'evidence'));
  return { root, evidence, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('REQ-2.7/2.11: unavailable sandbox fails closed with core-owned evidence', async () => {
  const fix = fixture();
  try {
    const runner = createCommandRunner({
      sandbox: { kind: 'unavailable', reason: 'no enforcing sandbox' },
      evidence: fix.evidence,
    });
    const result = await runner.run({
      command: 'true',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: ['test/golden'],
      allowNetwork: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, 'sandbox_unavailable');
    assert.match(fix.evidence.getText(result.evidenceRef), /sandbox:unavailable/);
    assert.match(fix.evidence.getText(result.evidenceRef), /exit:-1/);
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.1/2.11: completed child status and output are captured at the shared boundary', async () => {
  const fix = fixture();
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence });
    const result = await runner.run({
      command: 'printf direct-output',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.egressBlocked, true);
    const captured = fix.evidence.getText(result.evidenceRef);
    assert.match(captured, /sandbox:enforced/);
    assert.match(captured, /egress-blocked:true/);
    assert.match(captured, /exit:0/);
    assert.match(captured, /direct-output/);
  } finally {
    fix.cleanup();
  }
});

test('child output is bounded before an untrusted command can exhaust core memory', async () => {
  const fix = fixture();
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence });
    const result = await runner.run({
      command: 'while :; do printf 0123456789; done',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 5_000,
    });

    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.equal(result.reason, 'output_limit');
      assert.notEqual(result.exitCode, 0);
    }
    const captured = fix.evidence.getText(result.evidenceRef);
    assert.match(captured, /output-truncated:true/);
    assert.ok(captured.length < 1_100_000, 'evidence stays within the configured capture ceiling');
  } finally {
    fix.cleanup();
  }
});

test('sandbox attribution ignores child-controlled denial text', async () => {
  const fix = fixture();
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence });
    const result = await runner.run({
      command: 'printf "permission denied\\n"',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
  } finally {
    fix.cleanup();
  }
});

test('an ordinary SIGKILL is typed without fabricated sandbox attribution', async () => {
  const fix = fixture();
  try {
    const signalSandbox: SandboxWrap = {
      kind: 'available',
      wrap: () => ({ cmd: '/bin/sh', args: ['-c', 'exec 2>/dev/null; kill -9 $$'] }),
    };
    const runner = createCommandRunner({ sandbox: signalSandbox, evidence: fix.evidence });
    const result = await runner.run({
      command: 'true',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'signaled');
    if (result.status === 'signaled') assert.equal(result.signal, 'SIGKILL');
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.5: a backend-owned direct observation produces sandbox_violation', async () => {
  const fix = fixture();
  try {
    const observingSandbox: SandboxWrap = {
      kind: 'available',
      wrap: () => ({ cmd: '/bin/sh', args: ['-c', 'exit 77'] }),
      observeDirectResult: ({ exitCode }) =>
        exitCode === 77
          ? { source: 'backend_owned', operation: 'filesystem' }
          : null,
    };
    const runner = createCommandRunner({ sandbox: observingSandbox, evidence: fix.evidence });
    const result = await runner.run({
      command: 'true',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') {
      assert.equal(result.reason, 'sandbox_violation');
      assert.deepEqual(result.observedViolation, {
        source: 'backend_owned',
        operation: 'filesystem',
      });
    }
  } finally {
    fix.cleanup();
  }
});

test(
  'REQ-2.5/2.22/2.40: a real SBPL direct-child kill is an enforcement-owned denial observation',
  {
    skip:
      process.platform !== 'darwin' || process.env['PHASE0_REAL_MACOS_TESTS'] !== '1'
        ? 'requires explicit execution outside a nested sandbox'
        : false,
  },
  async () => {
    const fix = fixture();
    try {
      const runner = createCommandRunner({
        sandbox: denyNetworkSandbox(process.platform),
        evidence: fix.evidence,
      });
      // The child hides every output channel it controls; attribution must come
      // from the parent-owned wait status alone (kernel state, not child output).
      const result = await runner.run({
        command: 'exec 2>/dev/null; printf hidden > forbidden.txt || true',
        workspaceRoot: fix.root,
        cwd: fix.root,
        writableRoots: [],
        protectedRoots: [],
        allowNetwork: false,
        timeoutMs: 1_000,
      });

      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') {
        assert.equal(result.reason, 'sandbox_violation');
        assert.deepEqual(result.observedViolation, {
          source: 'enforcement_owned_direct',
          operation: 'unknown',
        });
      }
      assert.equal(existsSync(join(fix.root, 'forbidden.txt')), false);
    } finally {
      fix.cleanup();
    }
  },
);

test(
  'REQ-2.22/2.23/2.37/2.40: a descendant denial the shell swallows stays unattributed, and the effect is still denied',
  {
    skip:
      process.platform !== 'darwin' || process.env['PHASE0_REAL_MACOS_TESTS'] !== '1'
        ? 'requires explicit execution outside a nested sandbox'
        : false,
  },
  async () => {
    const fix = fixture();
    try {
      const runner = createCommandRunner({
        sandbox: denyNetworkSandbox(process.platform),
        evidence: fix.evidence,
      });
      // The denied write happens in a SUBSHELL whose kill the parent swallows,
      // then the parent exits 0. Observation scope is `direct_only`, so core
      // must NOT claim it detected this — and must not be tricked into
      // reporting success as a violation either. The denial itself still holds.
      const result = await runner.run({
        command: '( printf hidden > forbidden.txt ) 2>/dev/null; exit 0',
        workspaceRoot: fix.root,
        cwd: fix.root,
        writableRoots: [],
        protectedRoots: [],
        allowNetwork: false,
        timeoutMs: 5_000,
      });

      assert.equal(result.status, 'completed');
      if (result.status === 'completed') assert.equal(result.exitCode, 0);
      assert.equal(
        existsSync(join(fix.root, 'forbidden.txt')),
        false,
        'enforcement denies the effect even when attribution is impossible',
      );
    } finally {
      fix.cleanup();
    }
  },
);

test('an offline-install graceful root may not weaken a protected root', () => {
  const fix = fixture();
  try {
    const sandbox = denyNetworkSandbox('darwin');
    assert.equal(sandbox.kind, 'available');
    if (sandbox.kind !== 'available') return;
    assert.throws(
      () =>
        sandbox.wrap({
          shellCmd: 'true',
          workspaceRoot: fix.root,
          writableRoots: [],
          protectedRoots: ['test/golden'],
          offlineInstall: { gracefulDenyRoots: ['test'] },
        }),
      /would weaken a protected root/u,
    );
    // A disjoint graceful root is accepted and emitted as a plain (killless) deny.
    const wrapped = sandbox.wrap({
      shellCmd: 'true',
      workspaceRoot: fix.root,
      writableRoots: [],
      protectedRoots: ['test/golden'],
      offlineInstall: { gracefulDenyRoots: ['.phase0-offline-sources/pkg'] },
    });
    const profile = wrapped.args[1] as string;
    assert.match(profile, /\(deny file-write\* \(subpath "[^"]*\.phase0-offline-sources\/pkg"\)\)/u);
    assert.doesNotMatch(profile, /allow network/u);
  } finally {
    fix.cleanup();
  }
});

test('normal completion terminates the whole process group before resolving', async () => {
  const fix = fixture();
  const delayed = join(fix.root, 'delayed.txt');
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence });
    const result = await runner.run({
      command: `/bin/sh -c 'sleep 0.3; printf late > "${delayed}"' >/dev/null 2>&1 &`,
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: ['.'],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'completed');
    await delay(600);
    assert.equal(existsSync(delayed), false, 'a detached writer cannot outlive the command result');
  } finally {
    fix.cleanup();
  }
});

test('capture ceiling counts encoded bytes, not JavaScript characters', async () => {
  const fix = fixture();
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence });
    const result = await runner.run({
      command: "/usr/bin/yes '€'",
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 5_000,
    });

    const evidencePath = join(fix.root, 'evidence', result.evidenceRef.slice('blob://'.length));
    assert.ok(
      statSync(evidencePath).size < 1_050_000,
      'the complete evidence blob stays below the byte ceiling plus bounded headers',
    );
  } finally {
    fix.cleanup();
  }
});

test('the sanitized environment keeps the active non-system package-manager toolchain usable and hash-bound', async () => {
  const fix = fixture();
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence }) as ReturnType<
      typeof createCommandRunner
    > & { environmentHash?: string };
    const result = await runner.run({
      command: 'pnpm --version',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 5_000,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.match(runner.environmentHash ?? '', /^[0-9a-f]{64}$/);
  } finally {
    fix.cleanup();
  }
});

test('an AbortSignal cancels and reaps a running command at the enforcement boundary', async () => {
  const fix = fixture();
  try {
    const passthrough: SandboxWrap = {
      kind: 'available',
      wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
    };
    const runner = createCommandRunner({ sandbox: passthrough, evidence: fix.evidence });
    const controller = new AbortController();
    const pending = runner.run({
      command: 'sleep 30',
      workspaceRoot: fix.root,
      cwd: fix.root,
      writableRoots: [],
      protectedRoots: [],
      allowNetwork: false,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.equal(result.reason, 'cancelled');
  } finally {
    fix.cleanup();
  }
});

test('REQ-2.28: evidence failures at wrap and post-child stages clean command scratch', async (t) => {
  for (const stage of ['wrap', 'post-child'] as const) {
    await t.test(stage, async () => {
      const fix = fixture();
      const scratchRoot = join(fix.root, 'scratch');
      mkdirSync(scratchRoot);
      const originalTmpdir = process.env['TMPDIR'];
      process.env['TMPDIR'] = scratchRoot;
      const evidence: EvidenceStore = {
        put() {
          throw new Error(`injected ${stage} evidence failure`);
        },
        get: fix.evidence.get.bind(fix.evidence),
        getText: fix.evidence.getText.bind(fix.evidence),
        has: fix.evidence.has.bind(fix.evidence),
      };
      const sandbox: SandboxWrap =
        stage === 'wrap'
          ? {
              kind: 'available',
              wrap() {
                throw new Error('injected sandbox wrap failure');
              },
            }
          : {
              kind: 'available',
              wrap: ({ shellCmd }) => ({ cmd: '/bin/sh', args: ['-c', shellCmd] }),
            };
      try {
        const runner = createCommandRunner({ sandbox, evidence });
        await assert.rejects(
          runner.run({
            command: 'true',
            workspaceRoot: fix.root,
            cwd: fix.root,
            writableRoots: [],
            protectedRoots: [],
            allowNetwork: false,
            timeoutMs: 1_000,
          }),
          new RegExp(`injected ${stage} evidence failure`, 'u'),
        );
        assert.deepEqual(readdirSync(scratchRoot), []);
      } finally {
        if (originalTmpdir === undefined) delete process.env['TMPDIR'];
        else process.env['TMPDIR'] = originalTmpdir;
        fix.cleanup();
      }
    });
  }
});
