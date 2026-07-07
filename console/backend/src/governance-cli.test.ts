// `platform governance list|approve <id>` — usable with NO server running (REQ-9.3).
// The subcommand reads/appends the durable governance log directly. RED -> GREEN.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureGovernanceApproved, readGovernanceLog } from 'core';

import { runGovernanceCommand } from './governance-cli.ts';

const now = () => 1_700_000_000_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'govcli-'));
  const policyDir = join(root, 'policies');
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(join(policyDir, 'gate-ladder.json'), JSON.stringify({ t0: { lint: 'pnpm lint' } }));
  const logPath = join(root, 'governance', 'events.jsonl');
  return { root, policyDir, logPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('list on an empty log -> exit 0, says none pending', () => {
  const f = fixture();
  try {
    const r = runGovernanceCommand({ argv: ['list'], logPath: f.logPath, policyDir: f.policyDir, now });
    assert.equal(r.code, 0);
    assert.match(r.out, /no pending/i);
  } finally {
    f.cleanup();
  }
});

test('no-server approve: refuse -> list shows it -> approve unblocks the next preflight (REQ-9.3)', () => {
  const f = fixture();
  try {
    // A preflight records the pending proposal (as bin wiring would).
    const refused = ensureGovernanceApproved({ policyDir: f.policyDir, logPath: f.logPath, clock: { now } });
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error('unreachable');

    const list = runGovernanceCommand({ argv: ['list'], logPath: f.logPath, policyDir: f.policyDir, now });
    assert.equal(list.code, 0);
    assert.match(list.out, new RegExp(refused.proposal.id));

    const ok = runGovernanceCommand({ argv: ['approve', refused.proposal.id], logPath: f.logPath, policyDir: f.policyDir, now });
    assert.equal(ok.code, 0);
    assert.match(ok.out, /approved/i);
    // A GOVERNANCE_CHANGE landed in the durable log; the snapshot now passes.
    assert.equal(readGovernanceLog(f.logPath).some((rec) => rec.type === 'GOVERNANCE_CHANGE'), true);
    assert.equal(ensureGovernanceApproved({ policyDir: f.policyDir, logPath: f.logPath, clock: { now } }).ok, true);
  } finally {
    f.cleanup();
  }
});

test('approve unknown id -> non-zero exit + stderr', () => {
  const f = fixture();
  try {
    const r = runGovernanceCommand({ argv: ['approve', 'gov-nope'], logPath: f.logPath, policyDir: f.policyDir, now });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /no.*proposal|not found/i);
  } finally {
    f.cleanup();
  }
});

test('approve without an id -> usage error', () => {
  const f = fixture();
  try {
    const r = runGovernanceCommand({ argv: ['approve'], logPath: f.logPath, policyDir: f.policyDir, now });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /usage|id/i);
  } finally {
    f.cleanup();
  }
});

test('unknown subcommand -> usage error', () => {
  const f = fixture();
  try {
    const r = runGovernanceCommand({ argv: ['frobnicate'], logPath: f.logPath, policyDir: f.policyDir, now });
    assert.notEqual(r.code, 0);
    assert.match(r.err, /usage/i);
  } finally {
    f.cleanup();
  }
});
