// Issue intake — pure store logic (REQ-8/9). `.ai/issues/<id>.json` per
// record; `<id>.goal.yaml` sits in the same dir on convert. Body is
// UNTRUSTED DATA (INV-3) — this module stores/echoes it, never interprets it.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parse as parseYaml } from 'yaml';
import { ContractInvalidError, freezeContract } from 'core';

import { convertIssue, createIssue, listIssues, rejectIssue, TITLE_MAX, BODY_MAX } from './issues.ts';

const NOW = Date.parse('2026-07-09T12:00:00Z');

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'issues-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('createIssue: open status, deterministic iss- id, persisted to disk (REQ-8.1/8.2)', () => {
  withDir((dir) => {
    const res = createIssue(dir, { title: 'slow CI', body: 'the build takes 20 minutes' }, () => NOW);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.match(res.issue.id, /^iss-[0-9a-f]{16}$/);
    assert.equal(res.issue.status, 'open');
    assert.ok(existsSync(join(dir, `${res.issue.id}.json`)));

    const again = createIssue(dir, { title: 'slow CI', body: 'the build takes 20 minutes' }, () => NOW);
    assert.ok(again.ok);
    if (again.ok) assert.equal(again.issue.id, res.issue.id, 'same title+createdAt -> same id (REQ-8.1 deterministic)');
  });
});

test('createIssue: over either cap refuses and writes nothing (REQ-8.3)', () => {
  withDir((dir) => {
    const bigTitle = createIssue(dir, { title: 'x'.repeat(TITLE_MAX + 1), body: 'ok' }, () => NOW);
    assert.deepEqual(bigTitle, { ok: false, reason: 'too_large' });
    const bigBody = createIssue(dir, { title: 'ok', body: 'x'.repeat(BODY_MAX + 1) }, () => NOW);
    assert.deepEqual(bigBody, { ok: false, reason: 'too_large' });
    assert.equal(readdirSync(dir).length, 0, 'nothing written for either over-cap attempt');
  });
});

test('listIssues: sorted oldest-first, ignores non-.json siblings like <id>.goal.yaml (REQ-8.4)', () => {
  withDir((dir) => {
    const a = createIssue(dir, { title: 'a', body: 'b' }, () => NOW);
    const b = createIssue(dir, { title: 'a2', body: 'b' }, () => NOW + 1000);
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    writeFileSync(join(dir, 'stray.goal.yaml'), 'not an issue record');
    const listed = listIssues(dir);
    assert.deepEqual(listed.map((i) => i.id), [a.issue.id, b.issue.id]);
  });
});

test('convertIssue: writes a draft goal.yaml that freezeContract structurally refuses unedited (REQ-9.1/9.4)', () => {
  withDir((dir) => {
    const created = createIssue(dir, { title: 'add retries', body: 'flaky network calls need a retry' }, () => NOW);
    assert.ok(created.ok);
    if (!created.ok) return;

    const res = convertIssue(dir, created.issue.id);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.equal(res.value.status, 'converted');
    assert.equal(res.value.goalDraftPath, join(dir, `${created.issue.id}.goal.yaml`));

    const raw = readFileSync(res.value.goalDraftPath as string);
    const text = raw.toString('utf8');
    assert.match(text, /^# HUMAN: fill ACs, risk, budget before running/);
    assert.match(text, /acceptance_criteria: \[\]/);

    const parsed: unknown = parseYaml(text);
    assert.throws(() => freezeContract(raw, parsed), ContractInvalidError, 'empty acceptance_criteria refused (REQ-9.4)');

    // REQ-9.3: convert never starts/schedules/enqueues a run — only the two files below exist.
    assert.deepEqual(readdirSync(dir).sort(), [`${created.issue.id}.goal.yaml`, `${created.issue.id}.json`].sort());
  });
});

test('convertIssue: refuses a non-open issue and an unknown id (REQ-9.2)', () => {
  withDir((dir) => {
    const created = createIssue(dir, { title: 't', body: 'b' }, () => NOW);
    assert.ok(created.ok);
    if (!created.ok) return;
    convertIssue(dir, created.issue.id);
    assert.deepEqual(convertIssue(dir, created.issue.id), { ok: false, reason: 'not_open' });
    assert.deepEqual(convertIssue(dir, 'iss-doesnotexist'), { ok: false, reason: 'not_found' });
  });
});

test('rejectIssue: rejects an open issue, refuses non-open and unknown ids (REQ-8.6)', () => {
  withDir((dir) => {
    const created = createIssue(dir, { title: 't', body: 'b' }, () => NOW);
    assert.ok(created.ok);
    if (!created.ok) return;
    const res = rejectIssue(dir, created.issue.id);
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.value.status, 'rejected');
    assert.deepEqual(rejectIssue(dir, created.issue.id), { ok: false, reason: 'not_open' });
    assert.deepEqual(rejectIssue(dir, 'iss-doesnotexist'), { ok: false, reason: 'not_found' });
  });
});
