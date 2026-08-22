#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  POLICY_FILES,
  snapshotHash,
  validateBootstrapGovernanceAppend,
  validateBootstrapPolicyBytes,
} from '../../core/src/governance/policy.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECK_NAME = 'B0 bootstrap authority';
const TARGET_REF = 'refs/heads/develop';
const MAX_API_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 10;
const MAX_RUN_ATTEMPTS = 25;
const MAX_ATTEMPT_LOOKUPS = 100;

export const EXACT_OPERATIONS = Object.freeze({
  '.ai/policies/agent-capabilities.json': 'added',
  'core/src/governance/policy.ts': 'modified',
  'core/src/governance/policy.test.ts': 'modified',
  '.ai/governance/events.jsonl': 'modified',
  '.ai/bin/check-b0-bootstrap.mjs': 'added',
  '.github/workflows/ci.yml': 'modified',
});

const PATHS = Object.freeze({
  policy: '.ai/policies/agent-capabilities.json',
  owner: 'core/src/governance/policy.ts',
  test: 'core/src/governance/policy.test.ts',
  log: '.ai/governance/events.jsonl',
  verifier: '.ai/bin/check-b0-bootstrap.mjs',
  workflow: '.github/workflows/ci.yml',
});

export class B0VerificationError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'B0VerificationError';
    this.code = code;
  }
}

function reject(code, detail) {
  throw new B0VerificationError(code, detail);
}

function assertCondition(condition, code, detail) {
  if (!condition) reject(code, detail);
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)), 'utf8');
}

function canonicalSha256(value) {
  return sha256(canonicalBytes(value));
}

function exactSha(value, label) {
  assertCondition(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value), 'INVALID_SHA', label);
  return value;
}

function exactPositiveInteger(value, label) {
  assertCondition(Number.isSafeInteger(value) && value > 0, 'INVALID_INTEGER', label);
  return value;
}

function asObject(value, code, detail) {
  assertCondition(value !== null && typeof value === 'object' && !Array.isArray(value), code, detail);
  return value;
}

function asArray(value, code, detail) {
  assertCondition(Array.isArray(value), code, detail);
  return value;
}

function parseRepository(value) {
  assertCondition(
    typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
    'INVALID_REPOSITORY',
    'GITHUB_REPOSITORY must be owner/name',
  );
  const [owner, repo] = value.split('/');
  return { owner, repo, fullName: value };
}

function readEvent(path) {
  assertCondition(typeof path === 'string' && path !== '', 'MISSING_EVENT', 'GITHUB_EVENT_PATH is required');
  const bytes = readFileSync(path);
  assertCondition(bytes.byteLength <= MAX_API_BYTES, 'EVENT_TOO_LARGE', 'event payload exceeds bound');
  try {
    return asObject(JSON.parse(bytes.toString('utf8')), 'INVALID_EVENT', 'event must be an object');
  } catch (error) {
    if (error instanceof B0VerificationError) throw error;
    reject('INVALID_EVENT', 'event payload is not JSON');
  }
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: MAX_API_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch {
    reject('GIT_READ_FAILED', `git ${args[0]} failed`);
  }
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return result.status === 0;
}

function gitPathHistory(commit, path) {
  const output = git(['log', '--format=%H', commit, '--', path]);
  return output === '' ? [] : output.split('\n');
}

function gitAddedHistory(commit, path) {
  const output = git(['log', '--diff-filter=A', '--format=%H', commit, '--', path]);
  return output === '' ? [] : output.split('\n');
}

export class AuthenticatedReadApi {
  constructor({ repository, token, apiUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
    this.repository = repository;
    this.token = token;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    assertCondition(typeof token === 'string' && token !== '', 'MISSING_CREDENTIAL', 'authenticated API token is required');
    assertCondition(typeof fetchImpl === 'function', 'API_UNAVAILABLE', 'fetch is unavailable');
  }

  async get(path, { accept = 'application/vnd.github+json', allow404 = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.apiUrl}/repos/${this.repository.fullName}${path}`, {
        method: 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.token}`,
          'User-Agent': 'b0-bootstrap-verifier',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      reject('API_UNAVAILABLE', `GET ${path} failed`);
    }
    if (allow404 && response.status === 404) return null;
    assertCondition(response.ok, 'API_REJECTED', `GET ${path} returned ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    assertCondition(!Number.isFinite(length) || length <= MAX_API_BYTES, 'API_RESPONSE_TOO_LARGE', path);
    const text = await response.text();
    assertCondition(Buffer.byteLength(text, 'utf8') <= MAX_API_BYTES, 'API_RESPONSE_TOO_LARGE', path);
    try {
      return JSON.parse(text);
    } catch {
      reject('API_INVALID_JSON', path);
    }
  }

  async pages(path, key = null, { requireStableKeyedCollection = false } = {}) {
    const values = [];
    const seenIds = new Set();
    let expectedTotal = null;
    let firstPageIds = null;
    const pagePath = (page) => {
      const separator = path.includes('?') ? '&' : '?';
      return `${path}${separator}per_page=100&page=${page}`;
    };
    const readPage = async (page, stabilityProbe = false) => {
      const payload = await this.get(pagePath(page));
      if (key === null) return { array: asArray(payload, 'API_INVALID_SHAPE', path), ids: null };
      const object = asObject(payload, 'API_INVALID_SHAPE', path);
      const array = asArray(object[key], 'API_INVALID_SHAPE', path);
      if (!requireStableKeyedCollection) return { array, ids: null };
      const total = object.total_count;
      assertCondition(Number.isSafeInteger(total) && total >= 0, 'API_COLLECTION_CHANGED', `${path}:invalid total_count`);
      if (expectedTotal === null) expectedTotal = total;
      assertCondition(total === expectedTotal, 'API_COLLECTION_CHANGED', `${path}:total_count changed`);
      const ids = array.map((raw) => {
        const row = asObject(raw, 'API_INVALID_SHAPE', `${path}:row`);
        assertCondition(Number.isSafeInteger(row.id) && row.id > 0, 'API_COLLECTION_CHANGED', `${path}:invalid row id`);
        return row.id;
      });
      if (!stabilityProbe) {
        for (const id of ids) {
          assertCondition(!seenIds.has(id), 'API_COLLECTION_CHANGED', `${path}:duplicate row id`);
          seenIds.add(id);
        }
      }
      return { array, ids };
    };
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const { array, ids } = await readPage(page);
      if (page === 1) firstPageIds = ids;
      values.push(...array);
      if (array.length < 100) {
        if (requireStableKeyedCollection) {
          assertCondition(values.length === expectedTotal, 'API_COLLECTION_CHANGED', `${path}:row count mismatch`);
          const probe = await readPage(1, true);
          assertCondition(
            JSON.stringify(probe.ids) === JSON.stringify(firstPageIds),
            'API_COLLECTION_CHANGED',
            `${path}:page 1 changed`,
          );
        }
        return values;
      }
    }
    reject('API_PAGE_LIMIT', path);
  }

  async content(path, ref, { allow404 = false } = {}) {
    exactSha(ref, `content ref for ${path}`);
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const payload = await this.get(`/contents/${encodedPath}?ref=${ref}`, { allow404 });
    if (payload === null) return null;
    const file = asObject(payload, 'CONTENT_INVALID', path);
    assertCondition(file.type === 'file' && file.encoding === 'base64' && typeof file.content === 'string', 'CONTENT_INVALID', path);
    const bytes = Buffer.from(file.content.replace(/\s/g, ''), 'base64');
    assertCondition(bytes.byteLength <= MAX_API_BYTES, 'CONTENT_TOO_LARGE', path);
    return bytes;
  }
}

export function verifyExactOperations(files) {
  const rows = asArray(files, 'FILE_SET_INVALID', 'pull request files');
  assertCondition(rows.length === Object.keys(EXACT_OPERATIONS).length, 'FILE_SET_INVALID', 'B0 must change exactly six files');
  const seen = new Set();
  for (const raw of rows) {
    const row = asObject(raw, 'FILE_SET_INVALID', 'file row');
    assertCondition(typeof row.filename === 'string' && !seen.has(row.filename), 'FILE_SET_INVALID', 'duplicate or invalid path');
    seen.add(row.filename);
    const expected = EXACT_OPERATIONS[row.filename];
    assertCondition(expected !== undefined && row.status === expected, 'FILE_OPERATION_INVALID', `${row.filename}:${row.status}`);
    assertCondition(row.previous_filename === undefined, 'FILE_RENAME_FORBIDDEN', row.filename);
  }
  assertCondition(Object.keys(EXACT_OPERATIONS).every((path) => seen.has(path)), 'FILE_SET_INVALID', 'missing exact path');
}

function normalizedRuleset(detail) {
  const ruleset = asObject(detail, 'RULESET_INVALID', 'ruleset detail');
  const conditions = asObject(ruleset.conditions, 'RULESET_INVALID', 'conditions');
  const refName = asObject(conditions.ref_name, 'RULESET_INVALID', 'ref_name');
  const rules = asArray(ruleset.rules, 'RULESET_INVALID', 'rules');
  const bypass = ruleset.bypass_actors === undefined
    ? []
    : asArray(ruleset.bypass_actors, 'RULESET_INVALID', 'bypass_actors');
  return {
    observedUpdatedAt: ruleset.updated_at,
    id: ruleset.id,
    name: ruleset.name,
    target: ruleset.target,
    source: ruleset.source,
    sourceType: ruleset.source_type,
    enforcement: ruleset.enforcement,
    conditions: {
      exclude: [...asArray(refName.exclude, 'RULESET_INVALID', 'ref exclude')].sort(),
      include: [...asArray(refName.include, 'RULESET_INVALID', 'ref include')].sort(),
    },
    bypassActors: bypass.map(canonicalValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    rules: rules.map((rule) => canonicalValue(rule)).sort((a, b) => {
      const left = `${a.type}:${JSON.stringify(a)}`;
      const right = `${b.type}:${JSON.stringify(b)}`;
      return left.localeCompare(right);
    }),
  };
}

export function selectRulesetBinding(details, targetRef = TARGET_REF) {
  const applicable = asArray(details, 'RULESET_INVALID', 'rulesets')
    .map(normalizedRuleset)
    .filter((ruleset) => (
      ruleset.target === 'branch'
      && ruleset.enforcement === 'active'
      && ruleset.conditions.include.includes(targetRef)
      && ruleset.conditions.exclude.length === 0
    ));
  assertCondition(applicable.length === 1, 'RULESET_AMBIGUOUS', `found ${applicable.length} active rulesets for ${targetRef}`);
  const ruleset = applicable[0];
  assertCondition(
    typeof ruleset.observedUpdatedAt === 'string' && Number.isFinite(Date.parse(ruleset.observedUpdatedAt)),
    'RULESET_TIME_INVALID',
    'updated_at',
  );
  exactPositiveInteger(ruleset.id, 'ruleset id');
  assertCondition(ruleset.bypassActors.length === 0, 'RULESET_BYPASS_FORBIDDEN', 'bypass list must be empty');

  const pullRules = ruleset.rules.filter((rule) => rule.type === 'pull_request');
  const statusRules = ruleset.rules.filter((rule) => rule.type === 'required_status_checks');
  assertCondition(pullRules.length === 1 && statusRules.length === 1, 'RULESET_INVALID', 'required rules must be unique');
  const pull = asObject(pullRules[0].parameters, 'RULESET_INVALID', 'pull_request parameters');
  const status = asObject(statusRules[0].parameters, 'RULESET_INVALID', 'status parameters');
  assertCondition(
    Number.isSafeInteger(pull.required_approving_review_count)
      && pull.required_approving_review_count === 0,
    'RULESET_REVIEW_COUNT',
    'approval count must be zero',
  );
  assertCondition(pull.require_last_push_approval === false, 'RULESET_LAST_PUSH', 'last push approval must be disabled');
  assertCondition(
    Array.isArray(pull.allowed_merge_methods)
      && pull.allowed_merge_methods.length === 1
      && pull.allowed_merge_methods[0] === 'squash',
    'RULESET_MERGE_METHOD',
    'squash must be the only merge method',
  );
  assertCondition(status.strict_required_status_checks_policy === true, 'RULESET_STATUS_STRICT', 'strict status checks required');
  assertCondition(status.do_not_enforce_on_create === false, 'RULESET_STATUS_CREATE', 'status checks must enforce on create');
  const checks = asArray(status.required_status_checks, 'RULESET_INVALID', 'required status checks');
  const requiredStatusChecks = checks.map((raw) => {
    const check = asObject(raw, 'RULESET_INVALID', 'required status check');
    assertCondition(typeof check.context === 'string' && check.context !== '', 'RULESET_STATUS_SOURCE', 'missing context');
    exactPositiveInteger(check.integration_id, `integration id for ${check.context}`);
    return { context: check.context, integrationId: check.integration_id };
  }).sort((left, right) => (
    left.context === CHECK_NAME ? -1 : right.context === CHECK_NAME ? 1 : left.context.localeCompare(right.context)
  ));
  assertCondition(
    new Set(requiredStatusChecks.map((check) => check.context)).size === requiredStatusChecks.length,
    'RULESET_STATUS_DUPLICATE',
    'required status contexts must be unique',
  );
  const b0Checks = requiredStatusChecks.filter((check) => check.context === CHECK_NAME);
  assertCondition(b0Checks.length === 1, 'RULESET_STATUS_MISSING', CHECK_NAME);
  const { observedUpdatedAt, ...config } = ruleset;
  return {
    binding: {
      rulesetId: ruleset.id,
      targetRef,
      rulesetConfigSha256: canonicalSha256(config),
      enforcement: 'active',
      requiredApprovingReviewCount: 0,
      requireLastPushApproval: false,
      strictRequiredStatusChecks: true,
      requiredStatusChecks,
      allowedMergeMethods: ['squash'],
      bypassActorCount: 0,
    },
    normalized: config,
    updatedAt: observedUpdatedAt,
  };
}

export function selectOperatorBinding({ pull, operatorAccount, operatorGithubLogin, requireMerged = false }) {
  const pr = asObject(pull, 'PULL_INVALID', 'pull request');
  const head = asObject(pr.head, 'PULL_INVALID', 'head');
  const base = asObject(pr.base, 'PULL_INVALID', 'base');
  const author = asObject(pr.user, 'PULL_INVALID', 'author');
  exactPositiveInteger(pr.number, 'pull request number');
  exactSha(head.sha, 'pull request head');
  assertCondition(base.ref === 'develop', 'PULL_BASE_INVALID', String(base.ref));
  const account = asObject(operatorAccount, 'OPERATOR_ACCOUNT_INVALID', operatorGithubLogin);
  assertCondition(
    account.login === operatorGithubLogin && account.type === 'User' && account.permissions?.push === true,
    'OPERATOR_ACCOUNT_INVALID',
    operatorGithubLogin,
  );
  assertCondition(author.login === operatorGithubLogin && author.type === 'User', 'PULL_AUTHOR_INVALID', String(author.login));
  if (requireMerged) {
    const mergedBy = asObject(pr.merged_by, 'MERGE_ACTOR_INVALID', 'merged_by');
    assertCondition(mergedBy.login === operatorGithubLogin && mergedBy.type === 'User', 'MERGE_ACTOR_INVALID', String(mergedBy.login));
    assertCondition(typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)), 'MERGE_TIME_INVALID', 'merged_at');
  }
  return {
    binding: {
      pullRequest: pr.number,
      exactHead: head.sha,
      operatorGithubLogin,
      prAuthorGithubLogin: author.login,
      prAuthorAccountType: 'User',
      ...(requireMerged ? {
        mergedByGithubLogin: pr.merged_by.login,
        mergedByAccountType: 'User',
        mergedAt: pr.merged_at,
      } : {}),
    },
  };
}

const B0_JOB = `  b0_bootstrap:
    name: B0 bootstrap authority
    runs-on: ubuntu-latest
    permissions:
      actions: read
      checks: read
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
      - name: Verify B0 bootstrap authority
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node .ai/bin/check-b0-bootstrap.mjs ci

`;

export function expectedCiWorkflow(baseBytes) {
  const base = Buffer.from(baseBytes).toString('utf8');
  const permissions = 'permissions:\n  contents: read\n';
  const jobs = 'jobs:\n';
  assertCondition(base.split(permissions).length === 2, 'CI_BASE_INVALID', 'root permissions marker');
  assertCondition(base.split(jobs).length === 2, 'CI_BASE_INVALID', 'jobs marker');
  assertCondition(!base.includes('B0 bootstrap authority') && !base.includes('b0_bootstrap:'), 'B0_REPLAY', 'B0 job already exists');
  return Buffer.from(
    base
      .replace(permissions, 'permissions:\n  actions: read\n  checks: read\n  contents: read\n  pull-requests: read\n')
      .replace(jobs, `${jobs}${B0_JOB}`),
    'utf8',
  );
}

export function verifyCiWorkflowBytes(baseBytes, headBytes) {
  const expected = expectedCiWorkflow(baseBytes);
  assertCondition(expected.equals(Buffer.from(headBytes)), 'CI_COMPOSITION_INVALID', 'workflow differs from exact B0 composition');
}

async function rulesetAuthority(api) {
  const summaries = await api.pages('/rulesets');
  const details = [];
  for (const summary of summaries) {
    const row = asObject(summary, 'RULESET_INVALID', 'ruleset summary');
    exactPositiveInteger(row.id, 'ruleset summary id');
    details.push(await api.get(`/rulesets/${row.id}`));
  }
  return selectRulesetBinding(details);
}

async function policySnapshotAt(api, ref) {
  const files = [];
  for (const name of POLICY_FILES) {
    const bytes = await api.content(`.ai/policies/${name}`, ref, { allow404: true });
    files.push({ path: name, sha256: bytes === null ? 'absent' : sha256(bytes) });
  }
  return snapshotHash({ files });
}

async function changedFiles(api, number) {
  return api.pages(`/pulls/${number}/files`);
}

async function collectPullAuthority(api, number, { baseShaOverride = null, requireMerged = false } = {}) {
  const pull = asObject(await api.get(`/pulls/${number}`), 'PULL_INVALID', 'pull request');
  const headSha = exactSha(asObject(pull.head, 'PULL_INVALID', 'head').sha, 'head sha');
  const baseSha = exactSha(baseShaOverride ?? asObject(pull.base, 'PULL_INVALID', 'base').sha, 'base sha');
  assertCondition(pull.base?.repo?.full_name === api.repository.fullName, 'PULL_REPOSITORY_INVALID', 'base repository');
  assertCondition(pull.head?.repo?.full_name === api.repository.fullName, 'PULL_REPOSITORY_INVALID', 'head repository');
  const files = await changedFiles(api, number);
  verifyExactOperations(files);

  const policyBytes = await api.content(PATHS.policy, headSha);
  const policyResult = validateBootstrapPolicyBytes(policyBytes);
  assertCondition(policyResult.ok, 'POLICY_INVALID', policyResult.ok ? '' : policyResult.reason);
  const collaborators = await api.pages('/collaborators?affiliation=all');
  const matches = collaborators.filter((account) => (
    account?.login === policyResult.operatorGithubLogin && account?.type === 'User'
  ));
  assertCondition(matches.length === 1, 'OPERATOR_ACCOUNT_INVALID', policyResult.operatorGithubLogin);
  const { binding: operatorBinding } = selectOperatorBinding({
    pull,
    operatorAccount: matches[0],
    operatorGithubLogin: policyResult.operatorGithubLogin,
    requireMerged,
  });
  const ruleset = await rulesetAuthority(api);

  const basePolicy = await api.content(PATHS.policy, baseSha, { allow404: true });
  const baseVerifier = await api.content(PATHS.verifier, baseSha, { allow404: true });
  assertCondition(basePolicy === null && baseVerifier === null, 'B0_REPLAY', 'bootstrap files already exist in base');

  const baseWorkflow = await api.content(PATHS.workflow, baseSha);
  const headWorkflow = await api.content(PATHS.workflow, headSha);
  verifyCiWorkflowBytes(baseWorkflow, headWorkflow);

  const baseLog = await api.content(PATHS.log, baseSha);
  const headLog = await api.content(PATHS.log, headSha);
  const afterHash = await policySnapshotAt(api, headSha);
  const logResult = validateBootstrapGovernanceAppend({
    baseBytes: baseLog,
    headBytes: headLog,
    expectedAfterHash: afterHash,
  });
  assertCondition(logResult.ok, 'GOVERNANCE_LOG_INVALID', logResult.ok ? '' : logResult.reason);

  return {
    pull,
    operatorBinding: { ...operatorBinding, ruleset: ruleset.binding },
    ruleset,
    files,
    headSha,
    baseSha,
    policyBytes,
    baseLog,
    headLog,
    headWorkflow,
    logResult,
  };
}

function verifyNoReachableBootstrap(baseSha) {
  for (const path of [PATHS.policy, PATHS.verifier]) {
    assertCondition(gitPathHistory(baseSha, path).length === 0, 'B0_REPLAY', `${path} exists in reachable history`);
  }
}

export async function verifyCurrentRun(api, context, authority) {
  const runId = exactPositiveInteger(Number(context.runId), 'GITHUB_RUN_ID');
  const run = asObject(await api.get(`/actions/runs/${runId}`), 'RUN_INVALID', 'workflow run');
  assertCondition(run.event === 'pull_request', 'RUN_INVALID', 'event must be pull_request');
  assertCondition(run.path === '.github/workflows/ci.yml' && run.name === 'CI', 'RUN_SOURCE_MISMATCH', 'unexpected workflow');
  assertCondition(run.head_sha === authority.headSha, 'RUN_HEAD_MISMATCH', String(run.head_sha));
  const runAttempt = exactPositiveInteger(Number(run.run_attempt), 'run attempt');
  const startedAt = Date.parse(String(run.run_started_at));
  assertCondition(Number.isFinite(startedAt), 'RUN_TIME_INVALID', 'run_started_at');
  assertCondition(Date.parse(authority.ruleset.updatedAt) <= startedAt, 'RULESET_CHANGED_AFTER_RUN', 'ruleset changed after run began');
  const jobs = await api.pages(
    `/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
    'jobs',
    { requireStableKeyedCollection: true },
  );
  const source = jobs.filter((job) => job?.name === CHECK_NAME);
  assertCondition(source.length === 1, 'SOURCE_CHECK_AMBIGUOUS', `found ${source.length} source jobs`);
  const sourceCheckRunId = exactPositiveInteger(source[0].id, 'source check run id');
  const sourceCheck = asObject(await api.get(`/check-runs/${sourceCheckRunId}`), 'CHECK_INVALID', 'source check run');
  const expected = authority.ruleset.binding.requiredStatusChecks.find((check) => check.context === CHECK_NAME);
  assertCondition(
    expected !== undefined
      && sourceCheck.name === CHECK_NAME
      && sourceCheck.head_sha === authority.headSha
      && ['queued', 'in_progress'].includes(sourceCheck.status)
      && sourceCheck.app?.id === expected.integrationId
      && sourceCheck.app?.slug === 'github-actions',
    'CHECK_SOURCE_MISMATCH',
    'current job does not match required source check',
  );
  return { run, sourceCheckRunId };
}

function fileEvidence(path, operation, bytes) {
  return { path, operation, sha256: sha256(bytes) };
}

export async function verifyRequiredChecks(api, headSha, expectedChecks, mergedAt) {
  const completedBy = Date.parse(String(mergedAt));
  assertCondition(Number.isFinite(completedBy), 'MERGE_TIME_INVALID', 'merged_at');
  const results = [];
  const workflowMemo = new Map();
  let attemptLookups = 0;

  const detailsSource = (value) => {
    let details;
    try {
      details = new URL(value);
    } catch {
      return null;
    }
    const segments = details.pathname.split('/').filter(Boolean);
    if (
      details.protocol !== 'https:'
      || details.hostname !== 'github.com'
      || details.username !== ''
      || details.password !== ''
      || details.port !== ''
      || details.search !== ''
      || details.hash !== ''
      || segments.length !== 7
      || segments[0] !== api.repository.owner
      || segments[1] !== api.repository.repo
      || segments[2] !== 'actions'
      || segments[3] !== 'runs'
      || !/^\d+$/.test(segments[4])
      || segments[5] !== 'job'
      || !/^\d+$/.test(segments[6])
    ) return null;
    const workflowRunId = Number(segments[4]);
    const jobId = Number(segments[6]);
    if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0 || !Number.isSafeInteger(jobId) || jobId <= 0) return null;
    return { workflowRunId, jobId };
  };

  const workflowAuthority = async (workflowRunId) => {
    if (workflowMemo.has(workflowRunId)) return workflowMemo.get(workflowRunId);
    const workflowRun = asObject(await api.get(`/actions/runs/${workflowRunId}`), 'RUN_INVALID', 'workflow run');
    const runAttempt = Number(workflowRun.run_attempt);
    const valid = workflowRun.id === workflowRunId
      && workflowRun.path === '.github/workflows/ci.yml'
      && workflowRun.name === 'CI'
      && workflowRun.event === 'pull_request'
      && workflowRun.head_sha === headSha
      && Number.isSafeInteger(runAttempt)
      && runAttempt > 0;
    if (!valid) {
      const unresolved = { valid: false };
      workflowMemo.set(workflowRunId, unresolved);
      return unresolved;
    }
    assertCondition(runAttempt <= MAX_RUN_ATTEMPTS, 'API_LOOKUP_LIMIT', `${workflowRunId}:run_attempt=${runAttempt}`);
    const jobsById = new Map();
    for (let attempt = 1; attempt <= runAttempt; attempt += 1) {
      attemptLookups += 1;
      assertCondition(attemptLookups <= MAX_ATTEMPT_LOOKUPS, 'API_LOOKUP_LIMIT', 'attempt lookup budget exhausted');
      const jobs = await api.pages(
        `/actions/runs/${workflowRunId}/attempts/${attempt}/jobs`,
        'jobs',
        { requireStableKeyedCollection: true },
      );
      for (const raw of jobs) {
        const job = asObject(raw, 'API_INVALID_SHAPE', `workflow ${workflowRunId} job`);
        const id = exactPositiveInteger(job.id, `workflow ${workflowRunId} job id`);
        const occurrences = jobsById.get(id) ?? [];
        occurrences.push({ attempt, job });
        jobsById.set(id, occurrences);
      }
    }
    const resolved = { valid: true, workflowRun, runAttempt, jobsById };
    workflowMemo.set(workflowRunId, resolved);
    return resolved;
  };

  for (const expected of expectedChecks) {
    const runs = await api.pages(
      `/commits/${headSha}/check-runs?check_name=${encodeURIComponent(expected.context)}&filter=all`,
      'check_runs',
      { requireStableKeyedCollection: true },
    );
    const candidates = [];
    for (const raw of runs) {
      const check = asObject(raw, 'CHECK_INVALID', expected.context);
      const completedAtMs = Date.parse(String(check.completed_at));
      if (
        check.name !== expected.context
        || check.head_sha !== headSha
        || check.status !== 'completed'
        || check.app?.slug !== 'github-actions'
        || check.app?.id !== expected.integrationId
        || !Number.isFinite(completedAtMs)
        || completedAtMs > completedBy
      ) continue;
      const source = detailsSource(check.details_url);
      if (source === null) continue;
      const workflow = await workflowAuthority(source.workflowRunId);
      if (!workflow.valid) continue;
      const matches = workflow.jobsById.get(source.jobId) ?? [];
      assertCondition(matches.length === 1, 'CHECK_SOURCE_MISMATCH', `${source.jobId}:found ${matches.length} attempts`);
      const { attempt, job } = matches[0];
      if (
        job.run_id !== source.workflowRunId
        || job.name !== expected.context
        || job.head_sha !== headSha
      ) continue;
      candidates.push({
        checkRunId: exactPositiveInteger(check.id, 'check run id'),
        name: check.name,
        headSha: check.head_sha,
        conclusion: check.conclusion,
        appId: check.app.id,
        appSlug: check.app.slug,
        workflowRunId: source.workflowRunId,
        runAttempt: attempt,
        completedAt: check.completed_at,
        completedAtMs,
      });
    }
    assertCondition(candidates.length > 0, 'CHECK_SUCCESS_MISSING', expected.context);
    const completedTimes = new Set();
    for (const candidate of candidates) {
      assertCondition(!completedTimes.has(candidate.completedAtMs), 'CHECK_SET_INVALID', `${expected.context}:duplicate completed_at`);
      completedTimes.add(candidate.completedAtMs);
    }
    candidates.sort((left, right) => right.completedAtMs - left.completedAtMs);
    const selected = candidates[0];
    assertCondition(selected.conclusion === 'success', 'CHECK_SUCCESS_MISSING', expected.context);
    results.push({
      checkRunId: selected.checkRunId,
      name: selected.name,
      headSha: selected.headSha,
      conclusion: 'SUCCESS',
      appId: selected.appId,
      appSlug: selected.appSlug,
      workflowRunId: selected.workflowRunId,
      runAttempt: selected.runAttempt,
      completedAt: selected.completedAt,
    });
  }
  return results;
}

function authorityEvidenceRef(authority, requiredChecks = []) {
  return `sha256:${canonicalSha256({
    pull: {
      number: authority.pull.number,
      author: authority.pull.user?.login,
      base: authority.baseSha,
      head: authority.headSha,
      operator: authority.operatorBinding.operatorGithubLogin,
      mergedBy: authority.pull.merged_by?.login ?? null,
      mergedAt: authority.pull.merged_at ?? null,
    },
    ruleset: authority.ruleset.normalized,
    requiredChecks,
  })}`;
}

function prHeadEvidence(authority, sourceCheckRunId, issuedAt, verifierBytes) {
  const evidenceWithoutHash = {
    schemaVersion: 1,
    pullRequest: authority.pull.number,
    exactHead: authority.headSha,
    targetRef: TARGET_REF,
    rulesetConfigSha256: authority.ruleset.binding.rulesetConfigSha256,
    expectedRequiredChecks: authority.ruleset.binding.requiredStatusChecks,
    verifierSha256: sha256(verifierBytes),
    sourceCheckRunId,
    inputSha256: canonicalSha256({
      pullRequest: authority.pull.number,
      headSha: authority.headSha,
      ruleset: authority.ruleset.normalized,
      policySha256: sha256(authority.policyBytes),
      governanceAfterHash: authority.logResult.afterHash,
    }),
    issuedAt,
  };
  return { ...evidenceWithoutHash, sha256: canonicalSha256(evidenceWithoutHash) };
}

async function runPrHead(context) {
  assertCondition(context.eventName === 'pull_request', 'MODE_INVALID', 'pr-head requires pull_request event');
  const number = exactPositiveInteger(Number(context.event.pull_request?.number ?? context.event.number), 'pull request number');
  const authority = await collectPullAuthority(context.api, number);
  assertCondition(authority.pull.state === 'open' && authority.pull.merged_at === null, 'PULL_STATE_INVALID', 'B0 PR must be open');
  assertCondition(git(['rev-parse', 'HEAD']) === authority.headSha, 'CHECKOUT_NOT_HEAD', 'checkout must be exact PR head');
  verifyNoReachableBootstrap(authority.baseSha);
  const current = await verifyCurrentRun(context.api, context, authority);
  const evidence = prHeadEvidence(
    authority,
    current.sourceCheckRunId,
    current.run.run_started_at,
    await context.api.content(PATHS.verifier, authority.headSha),
  );
  const result = {
    mode: 'pr-head',
    repository: context.repository.fullName,
    operatorGithubLogin: authority.operatorBinding.operatorGithubLogin,
    ruleset: authority.ruleset.binding,
    governanceAfterHash: authority.logResult.afterHash,
    githubAuthorityEvidenceRef: authorityEvidenceRef(authority),
    prHeadEvidence: evidence,
    workflowRunId: current.run.id,
    workflowRunAttempt: current.run.run_attempt,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function discoverPolicyCommit(head) {
  const policyAdds = gitAddedHistory(head, PATHS.policy);
  const verifierAdds = gitAddedHistory(head, PATHS.verifier);
  assertCondition(
    policyAdds.length === 1 && verifierAdds.length === 1 && policyAdds[0] === verifierAdds[0],
    'B0_HISTORY_INVALID',
    'bootstrap CREATE commit must be unique',
  );
  return exactSha(policyAdds[0], 'policy commit');
}

async function associatedPull(api, policyCommit) {
  const pulls = asArray(
    await api.get(`/commits/${policyCommit}/pulls`, { accept: 'application/vnd.github+json' }),
    'PULL_INVALID',
    'associated pulls',
  ).filter((pull) => pull?.merged_at !== null && pull?.merge_commit_sha === policyCommit);
  assertCondition(pulls.length === 1, 'B0_PULL_AMBIGUOUS', `found ${pulls.length} merged pulls`);
  return pulls[0];
}

async function runPostMerge(context) {
  const currentHead = exactSha(git(['rev-parse', 'HEAD']), 'current head');
  const policyCommit = discoverPolicyCommit(currentHead);
  assertCondition(isAncestor(policyCommit, currentHead), 'B0_ANCESTRY_INVALID', 'policy commit is not ancestor');

  const commit = asObject(await context.api.get(`/commits/${policyCommit}`), 'COMMIT_INVALID', 'policy commit');
  assertCondition(Array.isArray(commit.parents) && commit.parents.length === 1, 'MERGE_METHOD_INVALID', 'squash commit must have one parent');
  verifyExactOperations(asArray(commit.files, 'COMMIT_INVALID', 'commit files'));
  const pullSummary = await associatedPull(context.api, policyCommit);
  const mergeParent = exactSha(commit.parents[0].sha, 'squash parent');
  const authority = await collectPullAuthority(context.api, pullSummary.number, {
    baseShaOverride: mergeParent,
    requireMerged: true,
  });
  assertCondition(authority.pull.merged_at !== null && authority.pull.merge_commit_sha === policyCommit, 'PULL_STATE_INVALID', 'pull must be squash merged');
  verifyNoReachableBootstrap(mergeParent);

  for (const path of Object.keys(EXACT_OPERATIONS)) {
    const reviewedBytes = await context.api.content(path, authority.headSha);
    const mergedBytes = await context.api.content(path, policyCommit);
    assertCondition(reviewedBytes.equals(mergedBytes), 'POSTIMAGE_MISMATCH', path);
  }
  const requiredChecks = await verifyRequiredChecks(
    context.api,
    authority.headSha,
    authority.ruleset.binding.requiredStatusChecks,
    authority.pull.merged_at,
  );
  const sourceCheck = requiredChecks.find((check) => check.name === CHECK_NAME);
  assertCondition(sourceCheck !== undefined, 'RULESET_STATUS_MISSING', CHECK_NAME);
  const sourceRun = asObject(
    await context.api.get(`/actions/runs/${sourceCheck.workflowRunId}`),
    'RUN_INVALID',
    'source workflow run',
  );
  const headEvidence = prHeadEvidence(
    authority,
    sourceCheck.checkRunId,
    sourceRun.run_started_at,
    await context.api.content(PATHS.verifier, authority.headSha),
  );
  const evidenceWithoutHash = {
    schemaVersion: 1,
    kind: 'B0_SINGLE_OPERATOR_BOOTSTRAP',
    authority: {
      ...authority.operatorBinding,
      mergeCommit: policyCommit,
      requiredChecks,
      prHeadEvidenceRef: `github-check-run:${sourceCheck.checkRunId}#${headEvidence.sha256}`,
      githubAuthorityEvidenceRef: authorityEvidenceRef(authority, requiredChecks),
    },
    mergeMethod: 'SQUASH',
    policyCommit,
    files: {
      agentPolicy: fileEvidence(PATHS.policy, 'CREATE', authority.policyBytes),
      policyOwner: fileEvidence(PATHS.owner, 'MODIFY', await context.api.content(PATHS.owner, authority.headSha)),
      policyTest: fileEvidence(PATHS.test, 'MODIFY', await context.api.content(PATHS.test, authority.headSha)),
      governanceLog: {
        path: PATHS.log,
        operation: 'APPEND',
        beforeBytes: authority.baseLog.byteLength,
        beforeSha256: sha256(authority.baseLog),
        afterSha256: sha256(authority.headLog),
        beforeHash: authority.logResult.beforeHash,
        afterHash: authority.logResult.afterHash,
        appendedRecordIds: authority.logResult.appendedRecordIds,
      },
      verifier: fileEvidence(PATHS.verifier, 'CREATE', await context.api.content(PATHS.verifier, authority.headSha)),
      ciWorkflow: fileEvidence(PATHS.workflow, 'MODIFY', authority.headWorkflow),
    },
  };
  const evidence = { ...evidenceWithoutHash, sha256: canonicalSha256(evidenceWithoutHash) };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

async function runCi(context) {
  if (context.eventName === 'pull_request') {
    const number = exactPositiveInteger(Number(context.event.pull_request?.number ?? context.event.number), 'pull request number');
    const pull = asObject(await context.api.get(`/pulls/${number}`), 'PULL_INVALID', 'pull request');
    const baseSha = exactSha(asObject(pull.base, 'PULL_INVALID', 'base').sha, 'base sha');
    const policy = await context.api.content(PATHS.policy, baseSha, { allow404: true });
    const verifier = await context.api.content(PATHS.verifier, baseSha, { allow404: true });
    assertCondition((policy === null) === (verifier === null), 'B0_BASE_INCONSISTENT', 'policy/verifier base presence differs');
    return policy === null ? runPrHead(context) : runPostMerge(context);
  }
  assertCondition(context.eventName === 'push', 'MODE_INVALID', 'ci supports pull_request or push');
  return runPostMerge(context);
}

function runtimeContext() {
  const repository = parseRepository(process.env.GITHUB_REPOSITORY);
  const event = readEvent(process.env.GITHUB_EVENT_PATH);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const api = new AuthenticatedReadApi({
    repository,
    token,
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  });
  return {
    repository,
    event,
    eventName: process.env.GITHUB_EVENT_NAME,
    runId: process.env.GITHUB_RUN_ID,
    api,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  assertCondition(argv.length === 1 && ['ci', 'pr-head', 'post-merge'].includes(mode), 'USAGE', 'check-b0-bootstrap.mjs <ci|pr-head|post-merge>');
  const context = runtimeContext();
  if (mode === 'ci') return runCi(context);
  if (mode === 'pr-head') return runPrHead(context);
  return runPostMerge(context);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    const code = error instanceof B0VerificationError ? error.code : 'UNEXPECTED_FAILURE';
    const detail = error instanceof B0VerificationError ? error.message.slice(code.length + 2) : 'verifier failed';
    process.stderr.write(`B0 BLOCKED [${code}]: ${detail}\n`);
    process.exitCode = 1;
  });
}
