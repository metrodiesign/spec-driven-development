// Generic secret detection for the context GOVERN stage (REQ-7.3, INV-14).
// Core-OWN patterns: key/token SHAPES + a Shannon-entropy heuristic — NO vendor
// strings, so the INV-7 grep stays clean. A hit BLOCKS the bundle build; content
// is never redacted-and-sent.

export interface SecretHit {
  hit: boolean;
  kind?: string;
  sample?: string;
}

// Token SHAPES (not specific values). Deliberately vendor-string-free.
const SHAPE_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'sk-key', re: /\bsk[_-][A-Za-z0-9_-]{16,}\b/ },
  { kind: 'gh-token', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { kind: 'gh-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'aws-key', re: /\bAKIA[A-Z0-9]{12,}\b/ },
  { kind: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** A long, charset-mixed, high-entropy token looks like a credential blob. */
function looksLikeHighEntropySecret(token: string): boolean {
  if (token.length < 20) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  if (!(hasUpper && hasLower && hasDigit)) return false;
  return entropy(token) > 3.5;
}

export function scanForSecret(content: string): SecretHit {
  for (const { kind, re } of SHAPE_PATTERNS) {
    const m = re.exec(content);
    if (m !== null) return { hit: true, kind, sample: m[0].slice(0, 8) + '…' };
  }
  for (const token of content.split(/[^A-Za-z0-9_-]+/)) {
    if (looksLikeHighEntropySecret(token)) {
      return { hit: true, kind: 'high-entropy', sample: token.slice(0, 8) + '…' };
    }
  }
  return { hit: false };
}
