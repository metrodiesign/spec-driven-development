// Governance display logic (pure, unit-tested) for F-Set / F-Perm / F-Auth / F-Mem.

export interface EffectiveEntry {
  value: unknown;
  scope: string;
}

/** One human-readable line per effective setting, showing which scope won. */
export function provenanceRows(effective: Record<string, EffectiveEntry>): string[] {
  return Object.entries(effective)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => `${key} = ${JSON.stringify(e.value)}  (from ${e.scope})`);
}

/** Preview a permission rule the way the CLI reads it. */
export function permissionRulePreview(rule: { action: string; pattern: string }): string {
  const verb = rule.action === 'deny' ? 'DENY' : rule.action === 'allow' ? 'ALLOW' : 'ASK';
  return `${verb} ${rule.pattern}`;
}

/** Auth banner text — red when the subscription is shadowed by an env var. */
export function authFullBanner(a: { severity: string; shadowingVars: string[]; guidance: string | null }): { level: 'red' | 'ok'; text: string } {
  if (a.severity === 'red') {
    return { level: 'red', text: `Subscription shadowed by ${a.shadowingVars.join(', ')} — ${a.guidance ?? ''}` };
  }
  return { level: 'ok', text: 'Using subscription login' };
}
