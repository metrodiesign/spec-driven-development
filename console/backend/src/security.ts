// Console security baseline (spec §13.1 + §13.3 Phase-0 subset, INV-14/15).
// Pure functions so every rule is unit-testable.

export interface StartupInput {
  host: string;
  insecure: boolean;
  /** Phase 0 ships no auth providers — always false here (REQ-12.2). */
  hasAuthProvider: boolean;
  /** REQ-20.1: the --behind-proxy public URL, when set. */
  behindProxy?: string;
}

export type StartupDecision =
  | { action: 'start' }
  | { action: 'start_with_warning'; warning: string }
  | { action: 'refuse'; message: string };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Fail-closed startup gate (spec §13.1, REQ-12.2/12.3, INV-15). REQ-20.1:
 * --behind-proxy forces the gate on even over a loopback bind (Tailscale Serve
 * proxies a public host onto it) — "a proxy flag never weakens", so once set,
 * neither the loopback shortcut nor --insecure can skip the provider check.
 */
export function decideStartup(input: StartupInput): StartupDecision {
  const forcedRemote = input.behindProxy !== undefined;
  if (!forcedRemote && isLoopback(input.host)) return { action: 'start' };
  if (!forcedRemote && input.insecure) {
    return {
      action: 'start_with_warning',
      warning:
        `INSECURE: binding ${input.host} with the auth gate DISABLED (--insecure). ` +
        'Anyone who can reach this port can read your session metadata. ' +
        'Never expose this to an untrusted network.',
    };
  }
  if (!input.hasAuthProvider) {
    return {
      action: 'refuse',
      message: forcedRemote
        ? '--behind-proxy is set, which forces the auth gate on and never permits --insecure ' +
          '(a proxy flag never weakens, REQ-20.1) — configure an auth provider first.'
        : `refusing to start: bind host ${input.host} is not loopback and no auth provider is ` +
          'configured (fail-closed, INV-15). Fix: bind 127.0.0.1 (default), or pass --insecure ' +
          'ONLY on a trusted network. Auth providers arrive in a later phase.',
    };
  }
  return { action: 'start' };
}

export interface BehindProxyTarget {
  /** Normalized `https://host[:port]` — no path/trailing slash (used to derive the OIDC redirectUri). */
  origin: string;
  /** `host[:port]` form, matching what an incoming Host header/CORS origin resolves to. */
  host: string;
}

/** Parses + validates `--behind-proxy` (REQ-20.2): must be https; null on anything else (caller refuses startup). */
export function parseBehindProxy(url: string): BehindProxyTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return { origin: parsed.origin, host: parsed.host };
  } catch {
    return null;
  }
}

/** Host-header allowlist (REQ-12.4): localhost forms + the configured bind host. */
export function hostHeaderAllowed(
  hostHeader: string | undefined,
  bindHost: string,
  port: number,
  proxyHost?: string,
): boolean {
  if (hostHeader === undefined) return false;
  const bare = hostHeader.startsWith('[')
    ? hostHeader.replace(/^\[([^\]]+)\](:\d+)?$/, '$1')
    : hostHeader.replace(/:\d+$/, '');
  // REQ-20.2: the --behind-proxy public host is allowlisted at ANY port — TLS
  // terminates upstream (Tailscale Serve forwards to a different internal
  // port), so port-pinning against the listen port doesn't apply to it.
  if (proxyHost !== undefined && bare === proxyHost) return true;
  const allowed = new Set(['127.0.0.1', '::1', 'localhost', bindHost]);
  if (!allowed.has(bare)) return false;
  // No explicit port = port 80 (the console never terminates TLS itself). It
  // must still equal the console port — otherwise `http://localhost` (:80),
  // a DIFFERENT origin, would count as the console's own (REQ-12.4).
  const portMatch = hostHeader.match(/:(\d+)$/);
  const effectivePort = portMatch === null ? 80 : Number(portMatch[1]);
  return effectivePort === port;
}

/** CORS origin allowlist on the same basis as the host allowlist (REQ-12.4). */
export function corsOriginAllowed(origin: string, bindHost: string, port: number, proxyHost?: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Resolve the origin's EFFECTIVE port (URL drops default ports) so the
    // port-pinning check above always sees an explicit one.
    const effectivePort = u.port !== '' ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    const hostWithPort = u.hostname.includes(':')
      ? `[${u.hostname}]:${effectivePort}`
      : `${u.hostname}:${effectivePort}`;
    return hostHeaderAllowed(hostWithPort, bindHost, port, proxyHost);
  } catch {
    return false;
  }
}

// Token-like values that must never leave the process in a response or log
// (REQ-12.5, INV-12/14). Patterns cover key/token shapes, not specific values.
const TOKEN_PATTERNS = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT shape
];

/** Paths of credential files must never appear in responses/logs (INV-14). */
const CREDENTIAL_PATH_PATTERN = /[^\s"']*(\.credentials(\.json)?|credentials\.json|\.netrc|id_rsa[^\s"']*)/g;

export function redactText(text: string, homeDir: string): string {
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '[redacted]');
  out = out.replace(CREDENTIAL_PATH_PATTERN, '[credential-path-redacted]');
  // Home prefix becomes display form `~` (REQ-12.5) — project paths stay usable.
  while (out.includes(homeDir)) out = out.replace(homeDir, '~');
  return out;
}
