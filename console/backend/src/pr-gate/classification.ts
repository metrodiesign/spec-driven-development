import {
  mergeChangeAnalysis,
  resolveProfiles,
  type AnalysisFragment,
  type AnalysisPlan,
  type EffectivePolicy,
  type PinnedChangeSet,
  type SnapshotIdentity,
} from 'core';

const MAX_FILES = 500;
const RISK_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

function component(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, 2).join('/') : parts[0]!;
}

function fragment(path: string): AnalysisFragment | null {
  const lower = path.toLowerCase();
  const components = [component(path)];
  const impactEdges = [{ from: path, to: components[0]!, reason: 'changed artifact affects component' }];
  if (/(?:^|\/)(?:openapi|swagger)(?:\.[^/]+)?\.(?:json|ya?ml)$/u.test(lower)) {
    return {
      technologies: ['openapi'], categories: ['API'], components, publicContracts: [path], impactEdges,
      risk: { level: 'HIGH', reasons: ['public API contract changed'] }, coverage: 'FULL',
    };
  }
  if (/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(lower)) {
    return { technologies: ['node-typescript'], categories: ['DEPENDENCY'], components, impactEdges, risk: { level: 'MEDIUM', reasons: ['dependency graph changed'] }, coverage: 'FULL' };
  }
  if (/\.(?:[cm]?[jt]sx?)$/u.test(lower)) {
    const testFile = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(lower);
    const publicApi = /^api\/|(?:^|\/)(?:routes?|controllers?|openapi)(?:\/|$)/u.test(lower);
    return {
      technologies: ['node-typescript'], categories: [testFile ? 'TEST' : publicApi ? 'API' : 'FEATURE'], components, impactEdges,
      publicContracts: publicApi ? [path] : [], risk: { level: publicApi ? 'HIGH' : 'MEDIUM', reasons: [publicApi ? 'public API implementation changed' : 'runtime code changed'] },
      coverage: 'FULL',
    };
  }
  if (/\.(?:md|mdx|rst|txt)$/u.test(lower)) {
    return { technologies: ['docs-config'], categories: ['DOCUMENTATION'], components, impactEdges, risk: { level: 'LOW', reasons: ['documentation changed'] }, coverage: 'FULL' };
  }
  if (/\.(?:json|ya?ml|toml)$/u.test(lower) || /(?:^|\/)(?:dockerfile|makefile)$/u.test(lower)) {
    return { technologies: ['docs-config'], categories: ['CONFIGURATION'], components, impactEdges, risk: { level: 'MEDIUM', reasons: ['configuration changed'] }, coverage: 'FULL' };
  }
  return null;
}

/** Phase-1 analyzers: Node/TS, docs/config, OpenAPI. Unknown files fail coverage closed. */
export function classifyPinnedChange(
  change: PinnedChangeSet,
  policy: EffectivePolicy,
  contextLimitations: Array<{ path: string; reason: string }> = [],
): AnalysisPlan {
  const files = [...change.files].sort((left, right) => left.path.localeCompare(right.path));
  const fragments: AnalysisFragment[] = [];
  const omitted: Array<{ path: string; reason: string }> = [];
  for (const file of files.slice(0, MAX_FILES)) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const values = paths.map(fragment).filter((value): value is AnalysisFragment => value !== null);
    if (values.length === 0) omitted.push({ path: file.path, reason: 'unsupported_phase1_technology' });
    else fragments.push(...values);
  }
  for (const file of files.slice(MAX_FILES)) omitted.push({ path: file.path, reason: 'phase1_file_count_limit' });
  omitted.push(...contextLimitations);
  if (files.length === 0) fragments.push({ coverage: 'FULL', risk: { level: 'LOW', reasons: ['empty change set'] } });
  if (omitted.length > 0) fragments.push({ coverage: 'LIMITED', omittedPaths: omitted });

  let analysis = mergeChangeAnalysis(fragments, policy.riskFloor);
  let resolved = resolveProfiles(policy, analysis);
  for (let index = 0; index < RISK_ORDER.length; index += 1) {
    const floor = resolved.profiles.reduce((risk, profile) => {
      if (profile.riskFloor === undefined) return risk;
      return RISK_ORDER.indexOf(profile.riskFloor) > RISK_ORDER.indexOf(risk) ? profile.riskFloor : risk;
    }, analysis.risk.level);
    if (floor === analysis.risk.level) break;
    analysis = mergeChangeAnalysis([
      analysis,
      { risk: { level: floor, reasons: [`activated profile risk floor: ${floor}`] } },
    ], policy.riskFloor);
    resolved = resolveProfiles(policy, analysis);
  }
  const snapshot: SnapshotIdentity = {
    repository: change.descriptor.repository,
    pullRequest: change.descriptor.number,
    baseSha: change.descriptor.baseSha,
    headSha: change.descriptor.headSha,
    mergeBaseSha: change.mergeBaseSha,
    diffRef: change.diffRef,
    policyRef: change.trustedRepositoryPolicyRef,
  };
  return { snapshot, analysis, profiles: resolved.profiles, checks: resolved.checks, policyRef: change.trustedRepositoryPolicyRef };
}
