// Bounded parallel dispatch (§10.2, REQ-6.2/6.3/6.4). A worker pool of size
// maxParallel drains the item list; before each send a worker consults the
// adapter's token bucket and, when empty, WAITS (poll `sleep`) for a refill rather
// than dropping the item (REQ-6.3). Per-item errors are captured in that item's
// result — one AdapterError never fails the batch (REQ-6.4). An adapter with no
// configured bucket is not rate-limited (unlimited).

import { AdapterError } from './protocol.ts';
import type { AdapterInterface, AgentRequest, AgentResponse } from './protocol.ts';
import type { TokenBucket } from './ratelimit.ts';

export interface DispatcherOptions {
  /** key = adapterId; an adapter absent from the map is not rate-limited. */
  buckets: Map<string, TokenBucket>;
  /** Maximum sends in flight at once (from routing.json). */
  maxParallel: number;
  /** Poll delay while an adapter's bucket is empty (default 5ms). Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
}

export interface DispatchItem {
  adapter: AdapterInterface;
  request: AgentRequest;
}

export interface DispatchResult {
  item: DispatchItem;
  outcome: { ok: true; response: AgentResponse } | { ok: false; error: AdapterError };
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createDispatcher(opts: DispatcherOptions): {
  dispatchAll(items: DispatchItem[]): Promise<DispatchResult[]>;
} {
  const sleep = opts.sleep ?? realSleep;
  const waitMs = opts.waitMs ?? 5;
  const maxParallel = Math.max(1, opts.maxParallel);

  return {
    async dispatchAll(items) {
      const results = new Array<DispatchResult>(items.length);
      let next = 0;

      async function runOne(item: DispatchItem): Promise<DispatchResult> {
        const bucket = opts.buckets.get(item.adapter.manifest().adapterId);
        // Wait for a token rather than drop the item (REQ-6.3). Bounded by the
        // caller's own budget/timeout — the panel size is small and finite.
        while (bucket !== undefined && !bucket.tryTake()) {
          await sleep(waitMs);
        }
        try {
          const response = await item.adapter.send(item.request);
          return { item, outcome: { ok: true, response } };
        } catch (err) {
          // Contract: adapters throw only AdapterError (INV-5). Wrap anything else so
          // one item's failure is captured, never thrown across the batch (REQ-6.4).
          const error = err instanceof AdapterError ? err : new AdapterError('transport', String(err));
          return { item, outcome: { ok: false, error } };
        }
      }

      async function worker(): Promise<void> {
        for (;;) {
          const i = next;
          if (i >= items.length) return;
          next += 1;
          results[i] = await runOne(items[i] as DispatchItem);
        }
      }

      // At most maxParallel workers => at most maxParallel sends in flight (REQ-6.2).
      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(maxParallel, items.length); w += 1) workers.push(worker());
      await Promise.all(workers);
      return results;
    },
  };
}
