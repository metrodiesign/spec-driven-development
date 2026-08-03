import {
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';

export interface ConventionRule {
  id: string;
  pattern: string;
  extensions?: string[];
  /** Explicit controls for this rule only; controls never apply globally. */
  allowedControls?: ConventionAllowedControl[];
}

export interface ConventionAllowedControl {
  id: string;
  pattern: string;
}

/** Versioned, syntactic-only convention policy. It intentionally has no AST or semantic hook. */
export interface ConventionPolicy {
  version: 1;
  roots: string[];
  rules: ConventionRule[];
}

export interface ConventionViolation {
  ruleId: string;
  path: string;
  line: number;
  syntax: string;
}

export interface ConventionResult {
  pass: boolean;
  detail: string;
  violations: ConventionViolation[];
}

/** Compatibility policy for isolated gate fixtures that do not carry a policy path. */
export const DEFAULT_CONVENTION_POLICY: ConventionPolicy = Object.freeze({
  version: 1,
  roots: ['test', 'tests', '__tests__'],
  rules: [
    {
      id: 'focused-or-skipped-test',
      pattern: '\\.\\s*(?:only|skip)\\s*\\(',
      extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
    },
  ],
});

export class ConventionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConventionPolicyError';
  }
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConventionPolicyError(`${label} must be a non-empty string`);
  }
  return value;
}

function parseAllowedControls(value: unknown, label: string): ConventionAllowedControl[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ConventionPolicyError(`${label} must be an array when present`);
  }
  return value.map((entry: unknown, index: number) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConventionPolicyError(`${label}[${index}] must be an object`);
    }
    const control = entry as Record<string, unknown>;
    const id = asNonEmptyString(control.id, `${label}[${index}].id`);
    const pattern = asNonEmptyString(control.pattern, `${label}[${index}].pattern`);
    try {
      new RegExp(pattern, 'u');
    } catch (error) {
      throw new ConventionPolicyError(
        `${label}[${index}].pattern is not a valid regexp: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return { id, pattern };
  });
}

function parseRule(value: unknown, index: number): ConventionRule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConventionPolicyError(`rules[${index}] must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const id = asNonEmptyString(raw.id, `rules[${index}].id`);
  const pattern = asNonEmptyString(raw.pattern, `rules[${index}].pattern`);
  try {
    // Compile at policy-load time so a malformed governance edit fails closed,
    // before any convention result can be reported as green.
    new RegExp(pattern, 'u');
  } catch (error) {
    throw new ConventionPolicyError(
      `rules[${index}].pattern is not a valid deterministic regexp: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const extensions = raw.extensions;
  const allowedControls = parseAllowedControls(raw.allowedControls, `rules[${index}].allowedControls`);
  if (extensions === undefined) {
    return {
      id,
      pattern,
      ...(allowedControls === undefined ? {} : { allowedControls }),
    };
  }
  if (
    !Array.isArray(extensions) ||
    extensions.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new ConventionPolicyError(`rules[${index}].extensions must be string[]`);
  }
  return {
    id,
    pattern,
    extensions: [...extensions],
    ...(allowedControls === undefined ? {} : { allowedControls }),
  };
}

export function parseConventionPolicy(bytes: string | Uint8Array): ConventionPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
  } catch (error) {
    throw new ConventionPolicyError(
      `malformed convention policy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConventionPolicyError('convention policy root must be an object');
  }
  const root = raw as Record<string, unknown>;
  if (root.version !== 1) throw new ConventionPolicyError('convention policy version must be 1');
  if (
    !Array.isArray(root.roots) ||
    root.roots.length === 0 ||
    root.roots.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new ConventionPolicyError('convention policy roots must be a non-empty string[]');
  }
  for (const configuredRoot of root.roots as string[]) {
    const normalizedRoot = normalize(configuredRoot);
    if (
      isAbsolute(configuredRoot) ||
      normalizedRoot === '..' ||
      normalizedRoot.startsWith(`..${sep}`)
    ) {
      throw new ConventionPolicyError(`convention policy root escapes worktree: ${configuredRoot}`);
    }
  }
  if (!Array.isArray(root.rules) || root.rules.length === 0) {
    throw new ConventionPolicyError('convention policy rules must be a non-empty array');
  }
  if (Object.prototype.hasOwnProperty.call(root, 'allowedControls')) {
    throw new ConventionPolicyError('allowedControls must be declared on the rule it controls');
  }
  const rules = root.rules.map(parseRule);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) throw new ConventionPolicyError(`duplicate convention rule id: ${rule.id}`);
    ids.add(rule.id);
  }
  return {
    version: 1,
    roots: [...root.roots] as string[],
    rules,
  };
}

function shouldInspect(file: string, rule: ConventionRule): boolean {
  if (rule.extensions === undefined) return true;
  return rule.extensions.some((extension) => file.endsWith(extension));
}

function allowedLine(line: string, rule: ConventionRule): boolean {
  // Controls are intentionally evaluated only against an explicit comment on
  // the same line. A string literal or a control belonging to another rule
  // cannot waive this rule's violation.
  const commentStart = Math.min(
    ...['//', '/*', '*'].map((marker) => {
      const index = line.indexOf(marker);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  if (!Number.isFinite(commentStart)) return false;
  const comment = line.slice(commentStart);
  return (rule.allowedControls ?? []).some((control) => new RegExp(control.pattern, 'u').test(comment));
}

function walk(root: string, dir: string, files: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, absolute, files);
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
  }
}

export function checkConvention(worktreeDir: string, policy: ConventionPolicy): ConventionResult {
  const violations: ConventionViolation[] = [];
  const files: string[] = [];
  for (const configuredRoot of policy.roots) {
    const root = join(worktreeDir, configuredRoot);
    try {
      if (lstatSync(root).isDirectory()) walk(worktreeDir, root, files);
    } catch {
      // Missing configured roots are not a prohibited syntax occurrence.
    }
  }
  for (const relativePath of files.sort()) {
    const body = readFileSync(join(worktreeDir, relativePath), 'utf8');
    for (const rule of policy.rules) {
      if (!shouldInspect(relativePath, rule)) continue;
      const matcher = new RegExp(rule.pattern, 'gu');
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(body)) !== null) {
        const lineStart = body.lastIndexOf('\n', match.index) + 1;
        const lineEnd = body.indexOf('\n', match.index);
        const line = body.slice(lineStart, lineEnd < 0 ? body.length : lineEnd);
        if (allowedLine(line, rule)) continue;
        violations.push({
          ruleId: rule.id,
          path: relativePath,
          line: body.slice(0, match.index).split(/\r?\n/u).length,
          syntax: match[0],
        });
      }
    }
  }
  if (violations.length === 0) {
    return { pass: true, detail: 'convention policy passed (syntactic rules only)', violations };
  }
  return {
    pass: false,
    detail: `prohibited convention syntax: ${violations
      .map((violation) => `${violation.ruleId} at ${violation.path}:${violation.line}`)
      .join(', ')}`,
    violations,
  };
}
