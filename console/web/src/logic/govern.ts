// Governance display logic (pure, unit-tested) for F-Set / F-Perm / F-Auth / F-Mem.

export interface EffectiveEntry {
  value: unknown;
  scope: string;
  provenance?: string;
}

export const GOVERNANCE_VIEWS = [
  'settings',
  'permissions',
  'memory',
  'mcp',
  'hooks',
  'subagents',
  'skills',
  'plugins',
  'system',
  'retention',
] as const;

export type GovernanceView = (typeof GOVERNANCE_VIEWS)[number];
export type GovernanceScope = 'managed' | 'user' | 'project' | 'local';
export type GovernanceDocumentKind = 'settings' | 'memory' | 'mcp' | 'hooks' | 'subagent' | 'skill';

export interface GovernanceRead {
  readonly content: string;
  readonly hash: string | null;
  readonly scope?: GovernanceScope;
  readonly provenance?: string;
  readonly readOnly?: boolean;
  readonly available?: boolean;
  readonly metadata: { readonly sensitive: true; readonly redacted: boolean };
}

export interface GovernanceEditorModel {
  readonly displayContent: string;
  readonly editableContent: string | null;
  readonly hash: string | null;
  readonly readOnly: boolean;
  readonly editMode: 'edit-redacted-safe' | 'replace-entire';
  readonly provenance: string;
}

const SCOPES: Readonly<Record<GovernanceView, readonly GovernanceScope[]>> = {
  settings: ['managed', 'user', 'project', 'local'],
  permissions: [],
  memory: ['user', 'project'],
  mcp: ['user', 'project'],
  hooks: ['user', 'project', 'local'],
  subagents: ['user', 'project'],
  skills: ['user', 'project'],
  plugins: ['user', 'project', 'local'],
  system: [],
  retention: ['user', 'project', 'local'],
};

export function governanceView(value: string | null): GovernanceView {
  return value !== null && (GOVERNANCE_VIEWS as readonly string[]).includes(value)
    ? value as GovernanceView
    : 'settings';
}

export function governanceScopes(view: GovernanceView): readonly GovernanceScope[] {
  return SCOPES[view];
}

export function governanceEditor(read: GovernanceRead): GovernanceEditorModel {
  return {
    displayContent: read.content,
    editableContent: read.metadata.redacted ? null : read.content,
    hash: read.hash,
    readOnly: read.readOnly === true || read.available === false,
    editMode: read.metadata.redacted ? 'replace-entire' : 'edit-redacted-safe',
    provenance: read.provenance ?? `${read.scope ?? 'unknown'} source`,
  };
}

function jsonObjectError(content: string, noun: string): string | null {
  try {
    const value = JSON.parse(content) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? null
      : `${noun} must be a JSON object`;
  } catch (error) {
    return `invalid JSON: ${(error as Error).message}`;
  }
}

export function validateGovernanceDocument(kind: GovernanceDocumentKind, content: string): string | null {
  if (kind === 'memory' || kind === 'skill') return content.trim() === '' ? 'content is required' : null;
  if (kind === 'subagent') {
    const frontmatter = /^---\n([\s\S]*?)\n---\n?[\s\S]*$/u.exec(content)?.[1];
    if (frontmatter === undefined) return 'missing YAML frontmatter (--- … ---)';
    for (const field of ['name', 'description', 'tools']) {
      if (!new RegExp(`^${field}:\\s*\\S`, 'mu').test(frontmatter)) return `frontmatter missing "${field}"`;
    }
    return null;
  }
  const noun = kind === 'mcp' ? 'mcp config' : 'settings';
  const error = jsonObjectError(content, noun);
  if (error !== null) return error;
  if (kind === 'hooks') {
    const hooks = (JSON.parse(content) as Record<string, unknown>)['hooks'];
    if (hooks === undefined) return null;
    if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 'hooks must be an object';
    const events = new Set([
      'PreToolUse', 'PostToolUse', 'Notification', 'UserPromptSubmit', 'Stop',
      'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact',
    ]);
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!events.has(event)) return `unknown hook event: ${event}`;
      if (!Array.isArray(groups)) return `hooks.${event} must be an array`;
      for (const group of groups) {
        if (typeof group !== 'object' || group === null || !Array.isArray((group as Record<string, unknown>)['hooks'])) {
          return `hooks.${event}[].hooks must be an array`;
        }
      }
    }
  }
  if (kind === 'mcp') {
    const servers = (JSON.parse(content) as Record<string, unknown>)['mcpServers'];
    if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
      return 'mcpServers must be an object';
    }
    for (const [name, entry] of Object.entries((servers ?? {}) as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) return `server ${name} must be an object`;
      const server = entry as Record<string, unknown>;
      if (typeof server['command'] !== 'string' && typeof server['url'] !== 'string') {
        return `server ${name} must have command or url`;
      }
    }
  }
  return null;
}

export interface PermissionInput {
  readonly rules: readonly { readonly action: 'allow' | 'deny' | 'ask'; readonly pattern: string; readonly scope?: string }[];
  readonly tool: string;
  readonly path: string;
}

export function parsePermissionInput(rulesText: string, tool: string, path: string): PermissionInput | string {
  if (tool.trim() === '' || path.trim() === '') return 'tool and path are required';
  try {
    const rules = JSON.parse(rulesText) as unknown;
    if (!Array.isArray(rules)) return 'rules must be a JSON array';
    for (const rule of rules) {
      if (
        typeof rule !== 'object'
        || rule === null
        || !['allow', 'deny', 'ask'].includes((rule as { action?: string }).action ?? '')
        || typeof (rule as { pattern?: unknown }).pattern !== 'string'
        || ('scope' in rule && typeof (rule as { scope?: unknown }).scope !== 'string')
      ) return 'each rule needs action, pattern, and optional scope';
    }
    return { rules: rules as PermissionInput['rules'], tool, path };
  } catch (error) {
    return `invalid JSON: ${(error as Error).message}`;
  }
}

export function enabledPluginNames(content: string): readonly string[] {
  try {
    const value = (JSON.parse(content) as Record<string, unknown>)['enabledPlugins'];
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').sort() : [];
  } catch {
    return [];
  }
}

export function retentionPeriodDays(content: string): number | null {
  try {
    const value = (JSON.parse(content) as Record<string, unknown>)['cleanupPeriodDays'];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  } catch {
    return null;
  }
}

/** One human-readable line per effective setting, showing which scope won. */
export function provenanceRows(effective: Record<string, EffectiveEntry>): string[] {
  return Object.entries(effective)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => `${key} = ${JSON.stringify(e.value)}  (from ${e.provenance ?? e.scope})`);
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
