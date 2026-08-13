// Per-provider token bucket (§10.2, REQ-6.1). Pure state + an INJECTED clock: the
// module never reads the wall clock, so refill is replayable in tests. One bucket
// per adapterId; the dispatcher consults it before every send so a parallel fan-out
// (a fusion panel) cannot stampede a provider.

export interface TokenBucketOptions {
  /** Maximum tokens the bucket holds (burst size). */
  capacity: number;
  /** Tokens replenished per second (fractional allowed; 0 = never refills). */
  refillPerSec: number;
}

export interface TokenBucket {
  /** Take n tokens (default 1) if available; true = taken, false = not enough (nothing consumed). */
  tryTake(n?: number): boolean;
  /** Current token count after refilling to `now()` — fractional. */
  available(): number;
  /** Current token count without refilling, reading the clock, or changing state. */
  peekAvailable(): number;
}

export function createTokenBucket(opts: TokenBucketOptions, now: () => number): TokenBucket {
  let tokens = opts.capacity;
  let last = now();

  function refill(): void {
    const t = now();
    const elapsedSec = (t - last) / 1000;
    if (elapsedSec > 0) {
      tokens = Math.min(opts.capacity, tokens + elapsedSec * opts.refillPerSec);
      last = t;
    }
  }

  return {
    tryTake(n = 1) {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return true;
      }
      return false;
    },
    available() {
      refill();
      return tokens;
    },
    peekAvailable() {
      return tokens;
    },
  };
}
