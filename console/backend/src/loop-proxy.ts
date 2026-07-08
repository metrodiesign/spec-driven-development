// F-Loop discovery + Human Plane client (REQ-15). Console = client, owns no
// state (INV-11): the Bearer token read from each run's discovery file is
// injected server-side per request and never returned to a caller.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface LoopRunRef {
  runId: string;
  runDir: string;
  /** Discovery file absent-or-tombstoned (REQ-15.6/15.9) — never conflated with present-but-unreachable (502, REQ-15.5). */
  ended: boolean;
  url?: string;
  token?: string;
}

interface DiscoveryFile {
  url?: unknown;
  token?: unknown;
  tombstoned?: unknown;
}

function readDiscoveryFile(path: string): DiscoveryFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DiscoveryFile;
  } catch {
    return null;
  }
}

/** Scan runsRoot/<runId>/human-plane.json (REQ-15.1). One subdirectory of runsRoot = one run. */
export function discoverRuns(runsRoot: string): LoopRunRef[] {
  if (!existsSync(runsRoot)) return [];
  const refs: LoopRunRef[] = [];
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsRoot, entry.name);
    const discovery = readDiscoveryFile(join(runDir, 'human-plane.json'));
    const live =
      discovery !== null &&
      discovery.tombstoned !== true &&
      typeof discovery.url === 'string' &&
      typeof discovery.token === 'string';
    refs.push(
      live
        ? { runId: entry.name, runDir, ended: false, url: discovery.url as string, token: discovery.token as string }
        : { runId: entry.name, runDir, ended: true },
    );
  }
  return refs;
}

/** A single run by id, path-contained against traversal (`..`, `/`) in the incoming param. */
export function findRun(runsRoot: string, runId: string): LoopRunRef | null {
  if (runId.length === 0 || runId.includes('/') || runId.includes('..')) return null;
  return discoverRuns(runsRoot).find((r) => r.runId === runId) ?? null;
}

export interface LoopFetchRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface LoopFetchResult {
  status: number;
  body: unknown;
}

/** Proxies to a run's Human Plane API, injecting the Bearer token server-side (REQ-15.2/15.3). */
export async function loopFetch(ref: LoopRunRef, req: LoopFetchRequest): Promise<LoopFetchResult> {
  if (ref.url === undefined || ref.token === undefined) {
    // Caller contract: check `ref.ended` before calling loopFetch (REQ-15.6 is a 409
    // at the route layer, never this 502 — the two failure modes stay distinct).
    return { status: 502, body: { upstream: 'human_plane_unreachable' } };
  }
  let res: Response;
  try {
    res = await fetch(`${ref.url}${req.path}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${ref.token}`,
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
    });
  } catch {
    return { status: 502, body: { upstream: 'human_plane_unreachable' } }; // REQ-15.5
  }
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}
