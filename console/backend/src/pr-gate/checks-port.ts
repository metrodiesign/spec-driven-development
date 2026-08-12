import { lstatSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { parse as parseYaml } from 'yaml';
import {
  runPlannedChecks,
  scanForSecret,
  type CoreCommandExecutor,
  type DeterministicCheckSpec,
  type EvidenceStore,
  type PinnedChangeSet,
  type PlannedCheckOutcome,
  type Sha256Ref,
  type SnapshotIdentity,
  type SnapshotManifest,
} from 'core';

import { createCorePlannedCheckExecutor } from './deterministic.ts';
import type { LocalGitObjectReader } from './local-git.ts';
import type { PrGateChecksPort } from './manager.ts';

function shaRef(ref: string): Sha256Ref {
  const hash = /^blob:\/\/([0-9a-f]{64})$/u.exec(ref)?.[1];
  if (hash === undefined) throw new Error('invalid evidence store ref');
  return `sha256:${hash}`;
}

function evidence(store: EvidenceStore, value: unknown): Sha256Ref {
  return shaRef(store.put(JSON.stringify(value)));
}

function contained(root: string, path: string): string {
  const base = resolve(root);
  const target = resolve(base, path);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error(`snapshot path escapes root: ${path}`);
  return target;
}

function secretScan(manifest: SnapshotManifest, worktreeDir: string | undefined, store: EvidenceStore): PlannedCheckOutcome {
  if (worktreeDir === undefined) throw new Error('secret scan requires materialized snapshot');
  for (const file of manifest.changedFiles) {
    if (file.afterRef === undefined) continue;
    const path = contained(worktreeDir, file.path);
    if (!lstatSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    if (bytes.byteLength > 2 * 1024 * 1024 || bytes.includes(0)) continue;
    const hit = scanForSecret(bytes.toString('utf8'));
    if (hit.hit) {
      return { status: 'FAILED', durationMs: 0, evidenceRef: evidence(store, { check: 'secret-scan', path: file.path, kind: hit.kind }) };
    }
  }
  return { status: 'PASSED', durationMs: 0, evidenceRef: evidence(store, { check: 'secret-scan', status: 'clean' }) };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const OPENAPI_PATH = /(?:^|\/)(?:openapi|swagger)(?:\.[^/]+)?\.(?:json|ya?ml)$/iu;

function breakingOpenApi(base: unknown, head: unknown): string[] {
  const removed: string[] = [];
  const basePaths = object(object(base)['paths']);
  const headPaths = object(object(head)['paths']);
  for (const [path, basePathValue] of Object.entries(basePaths)) {
    const headPathValue = object(headPaths[path]);
    if (!(path in headPaths)) { removed.push(`path:${path}`); continue; }
    const basePath = object(basePathValue);
    for (const method of HTTP_METHODS) {
      if (method in basePath && !(method in headPathValue)) removed.push(`operation:${method.toUpperCase()} ${path}`);
    }
  }
  const baseSchemas = object(object(object(base)['components'])['schemas']);
  const headSchemas = object(object(object(head)['components'])['schemas']);
  for (const name of Object.keys(baseSchemas)) if (!(name in headSchemas)) removed.push(`schema:${name}`);
  return removed.sort();
}

async function openApiCheck(input: {
  reader: LocalGitObjectReader;
  change: PinnedChangeSet;
  store: EvidenceStore;
  signal: AbortSignal;
}): Promise<PlannedCheckOutcome> {
  const files = input.change.files.filter((file) => OPENAPI_PATH.test(file.path) || (file.previousPath !== undefined && OPENAPI_PATH.test(file.previousPath)));
  const removed: Array<{ path: string; item: string }> = [];
  try {
    for (const file of files) {
      const basePath = file.previousPath ?? file.path;
      if (OPENAPI_PATH.test(basePath) && !OPENAPI_PATH.test(file.path)) {
        removed.push({ path: basePath, item: `contract-file-renamed:${file.path}` });
        continue;
      }
      const baseText = await input.reader.readText('base', basePath, input.change, 8 * 1024 * 1024, input.signal);
      const headText = await input.reader.readText('head', file.path, input.change, 8 * 1024 * 1024, input.signal);
      if (baseText !== null && headText === null) { removed.push({ path: basePath, item: 'contract-file' }); continue; }
      if (baseText === null || headText === null) continue;
      for (const item of breakingOpenApi(parseYaml(baseText), parseYaml(headText))) removed.push({ path: file.path, item });
    }
  } catch (error) {
    return { status: 'FAILED', durationMs: 0, evidenceRef: evidence(input.store, { check: 'openapi-contract', error: error instanceof Error ? error.message : String(error) }) };
  }
  return {
    status: removed.length === 0 ? 'PASSED' : 'FAILED', durationMs: 0,
    evidenceRef: evidence(input.store, { check: 'openapi-contract', removed }),
  };
}

export function createPrGateChecksPort(input: {
  reader: LocalGitObjectReader;
  changeFor(identity: SnapshotIdentity): PinnedChangeSet | undefined;
  evidence: EvidenceStore;
  commandExecutor: CoreCommandExecutor;
}): PrGateChecksPort {
  return {
    async run(plan, manifest, worktreeDir, signal, inputRoots) {
      const command = worktreeDir === undefined ? null : createCorePlannedCheckExecutor({
        executor: input.commandExecutor,
        worktreeDir,
        ...(inputRoots === undefined ? {} : { additionalInputRoots: inputRoots }),
      });
      const change = input.changeFor(plan.snapshot);
      return runPlannedChecks({
        snapshot: plan.snapshot,
        checks: plan.checks,
        signal,
        executor: {
          async execute(check: Readonly<DeterministicCheckSpec>, checkSignal: AbortSignal) {
            if (check.command === 'builtin:secret-scan') return secretScan(manifest, worktreeDir, input.evidence);
            if (check.command === 'builtin:openapi-contract-diff') {
              if (change === undefined) throw new Error('pinned change unavailable');
              return openApiCheck({ reader: input.reader, change, store: input.evidence, signal: checkSignal });
            }
            if (command === null) throw new Error('planned command requires materialized snapshot');
            return command.execute(check, checkSignal);
          },
        },
      });
    },
  };
}
