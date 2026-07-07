// Core-OWN generic redaction for Human Plane API projections (REQ-10.3, INV-14).
// No vendor strings (INV-7); NOT a reuse of console redaction (that would cross a
// ring boundary). Shape-based replacement of key/token-like values.

const PATTERNS: RegExp[] = [
  /\bsk[_-][A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}
