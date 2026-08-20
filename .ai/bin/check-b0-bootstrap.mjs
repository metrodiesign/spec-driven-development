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

  async pages(path, key = null) {
    const values = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const payload = await this.get(`${path}${separator}per_page=100&page=${page}`);
      const pageValues = key === null ? payload : asObject(payload, 'API_INVALID_SHAPE', path)[key];
      const array = asArray(pageValues, 'API_INVALID_SHAPE', path);
      values.push(...array);
      if (array.length < 100) return values;
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
      && pull.required_approving_review_count >= 1,
    'RULESET_REVIEW_COUNT',
    'at least one approval is required',
  );
  assertCondition(pull.require_last_push_approval === true, 'RULESET_LAST_PUSH', 'last push approval must be required');
  assertCondition(pull.dismiss_stale_reviews_on_push === true, 'RULESET_STALE_REVIEW', 'stale reviews must be dismissed');
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
  const b0Checks = checks.filter((check) => check?.context === CHECK_NAME);
  assertCondition(b0Checks.length === 1, 'RULESET_STATUS_MISSING', CHECK_NAME);
  const integrationId = b0Checks[0].integration_id;
  assertCondition(
    integrationId === undefined || (Number.isSafeInteger(integrationId) && integrationId > 0),
    'RULESET_STATUS_SOURCE',
    'invalid integration id',
  );
  const { observedUpdatedAt, ...config } = ruleset;
  return {
    binding: {
      rulesetId: ruleset.id,
      targetRef,
      rulesetConfigSha256: canonicalSha256(config),
      requiredApprovingReviewCount: pull.required_approving_review_count,
      requireLastPushApproval: true,
      dismissStaleReviews: true,
      requiredStatusCheck: CHECK_NAME,
    },
    integrationId: integrationId ?? null,
    normalized: config,
    updatedAt: observedUpdatedAt,
  };
}

function isAutomationLogin(login) {
  return /\[bot\]$|(?:^|[-_])(bot|agent|automation)(?:$|[-_])/i.test(login);
}

export function selectReviewBinding({ pull, reviews, accountsByLogin, policyReviewers }) {
  const pr = asObject(pull, 'PULL_INVALID', 'pull request');
  const head = asObject(pr.head, 'PULL_INVALID', 'head');
  const base = asObject(pr.base, 'PULL_INVALID', 'base');
  const author = asObject(pr.user, 'PULL_INVALID', 'author');
  exactPositiveInteger(pr.number, 'pull request number');
  exactSha(head.sha, 'pull request head');
  assertCondition(base.ref === 'develop', 'PULL_BASE_INVALID', String(base.ref));
  assertCondition(typeof author.login === 'string', 'PULL_AUTHOR_INVALID', 'missing author login');
  assertCondition(Array.isArray(policyReviewers) && policyReviewers.length > 0, 'POLICY_REVIEWER_INVALID', 'empty allowlist');

  const accounts = asObject(accountsByLogin, 'REVIEWER_ACCOUNT_INVALID', 'accounts');
  for (const login of policyReviewers) {
    const account = asObject(accounts[login], 'REVIEWER_ACCOUNT_INVALID', login);
    assertCondition(
      account.login === login && account.type === 'User' && account.permissions?.push === true,
      'REVIEWER_ACCOUNT_INVALID',
      login,
    );
    assertCondition(!isAutomationLogin(login), 'REVIEWER_AUTOMATION_FORBIDDEN', login);
  }

  const latest = new Map();
  for (const raw of asArray(reviews, 'REVIEW_INVALID', 'reviews')) {
    const review = asObject(raw, 'REVIEW_INVALID', 'review');
    const user = asObject(review.user, 'REVIEW_INVALID', 'review user');
    if (typeof user.login !== 'string') continue;
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    const prior = latest.get(user.login);
    if (prior === undefined || Number(review.id) > Number(prior.id)) latest.set(user.login, review);
  }
  const valid = [...latest.values()].filter((review) => (
    review.state === 'APPROVED'
    && review.commit_id === head.sha
    && review.user?.type === 'User'
    && policyReviewers.includes(review.user.login)
    && review.user.login.toLowerCase() !== author.login.toLowerCase()
    && !isAutomationLogin(review.user.login)
    && accounts[review.user.login]?.login === review.user.login
    && accounts[review.user.login]?.type === 'User'
    && accounts[review.user.login]?.permissions?.push === true
  ));
  assertCondition(valid.length >= 1, 'EXACT_HEAD_APPROVAL_MISSING', 'no eligible exact-head approval');
  valid.sort((a, b) => Number(b.id) - Number(a.id));
  const review = valid[0];
  exactPositiveInteger(review.id, 'review id');
  assertCondition(typeof review.submitted_at === 'string' && !Number.isNaN(Date.parse(review.submitted_at)), 'REVIEW_TIME_INVALID', 'submitted_at');
  return {
    review,
    binding: {
      pullRequest: pr.number,
      reviewId: review.id,
      reviewedHead: head.sha,
      reviewerGithubLogin: review.user.login,
      reviewerAccountType: 'User',
      prAuthorGithubLogin: author.login,
    },
  };
}

const B0_JOB = `  b0_bootstrap:
    name: B0 bootstrap authority
    runs-on: ubuntu-latest
    permissions:
      actions: read
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
      .replace(permissions, 'permissions:\n  actions: read\n  contents: read\n  pull-requests: read\n')
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

async function collectPullAuthority(api, number, { baseShaOverride = null } = {}) {
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
  const accountsByLogin = {};
  for (const login of policyResult.humanReviewers) {
    const matches = collaborators.filter((account) => account?.login === login && account?.type === 'User');
    assertCondition(matches.length === 1, 'REVIEWER_ACCOUNT_INVALID', login);
    accountsByLogin[login] = matches[0];
  }
  const reviews = await api.pages(`/pulls/${number}/reviews`);
  const { review, binding: reviewBinding } = selectReviewBinding({
    pull,
    reviews,
    accountsByLogin,
    policyReviewers: policyResult.humanReviewers,
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
    review,
    reviewBinding: { ...reviewBinding, ruleset: ruleset.binding },
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

async function verifyCurrentRun(api, context, authority) {
  const runId = exactPositiveInteger(Number(context.runId), 'GITHUB_RUN_ID');
  const run = asObject(await api.get(`/actions/runs/${runId}`), 'RUN_INVALID', 'workflow run');
  assertCondition(run.event === 'pull_request', 'RUN_INVALID', 'event must be pull_request');
  assertCondition(run.path === '.github/workflows/ci.yml' && run.name === 'CI', 'RUN_SOURCE_MISMATCH', 'unexpected workflow');
  assertCondition(run.head_sha === authority.headSha, 'RUN_HEAD_MISMATCH', String(run.head_sha));
  assertCondition(Number(run.run_attempt) >= 2, 'RUN_NOT_RERUN', 'approve then rerun same head');
  const startedAt = Date.parse(String(run.run_started_at));
  const reviewedAt = Date.parse(String(authority.review.submitted_at));
  assertCondition(Number.isFinite(startedAt) && startedAt >= reviewedAt, 'RUN_BEFORE_REVIEW', 'rerun must start after approval');
  assertCondition(Date.parse(authority.ruleset.updatedAt) <= startedAt, 'RULESET_CHANGED_AFTER_RUN', 'ruleset changed after rerun began');
  return run;
}

function fileEvidence(path, operation, bytes) {
  return { path, operation, sha256: sha256(bytes) };
}

export async function verifyPassedB0Check(api, headSha, review, integrationId) {
  const payload = asObject(
    await api.get(`/commits/${headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&filter=all&per_page=100`, {
      accept: 'application/vnd.github+json',
    }),
    'CHECK_INVALID',
    'check-runs',
  );
  const runs = asArray(payload.check_runs, 'CHECK_INVALID', 'check_runs').filter((run) => (
    run?.name === CHECK_NAME
    && run?.head_sha === headSha
    && run?.status === 'completed'
    && run?.conclusion === 'success'
    && run?.app?.slug === 'github-actions'
    && Number.isSafeInteger(run?.app?.id)
    && run.app.id > 0
    && Date.parse(String(run.started_at)) >= Date.parse(String(review.submitted_at))
  ));
  assertCondition(runs.length >= 1, 'CHECK_SUCCESS_MISSING', CHECK_NAME);
  runs.sort((a, b) => Number(b.id) - Number(a.id));
  const selected = runs[0];
  if (integrationId !== null) {
    assertCondition(selected.app.id === integrationId, 'CHECK_SOURCE_MISMATCH', 'ruleset integration differs');
  }
  let details;
  try {
    details = new URL(selected.details_url);
  } catch {
    reject('CHECK_SOURCE_MISMATCH', 'invalid details URL');
  }
  const segments = details.pathname.split('/').filter(Boolean);
  assertCondition(
    details.protocol === 'https:'
      && details.hostname === 'github.com'
      && segments[0] === api.repository.owner
      && segments[1] === api.repository.repo
      && segments[2] === 'actions'
      && segments[3] === 'runs'
      && /^\d+$/.test(segments[4] ?? '')
      && segments[5] === 'job'
      && /^\d+$/.test(segments[6] ?? ''),
    'CHECK_SOURCE_MISMATCH',
    'check is not an Actions job in this repository',
  );
  const workflowRun = asObject(await api.get(`/actions/runs/${segments[4]}`), 'RUN_INVALID', 'passing workflow run');
  assertCondition(
    workflowRun.path === '.github/workflows/ci.yml'
      && workflowRun.name === 'CI'
      && workflowRun.event === 'pull_request'
      && workflowRun.head_sha === headSha
      && Number(workflowRun.run_attempt) >= 2
      && Date.parse(String(workflowRun.run_started_at)) >= Date.parse(String(review.submitted_at)),
    'CHECK_SOURCE_MISMATCH',
    'passing check does not bind reviewed CI rerun',
  );
  return { check: selected, workflowRun };
}

function authorityEvidenceRef(authority, passed = null) {
  return `sha256:${canonicalSha256({
    pull: {
      number: authority.pull.number,
      author: authority.pull.user?.login,
      base: authority.baseSha,
      head: authority.headSha,
    },
    review: {
      id: authority.review.id,
      login: authority.review.user?.login,
      state: authority.review.state,
      commitId: authority.review.commit_id,
      submittedAt: authority.review.submitted_at,
    },
    ruleset: authority.ruleset.normalized,
    check: passed === null ? null : {
      id: passed.check.id,
      name: passed.check.name,
      headSha: passed.check.head_sha,
      status: passed.check.status,
      conclusion: passed.check.conclusion,
      appId: passed.check.app?.id,
      appSlug: passed.check.app?.slug,
      startedAt: passed.check.started_at,
      completedAt: passed.check.completed_at,
      workflowRunId: passed.workflowRun.id,
      workflowPath: passed.workflowRun.path,
      workflowRunAttempt: passed.workflowRun.run_attempt,
    },
  })}`;
}

async function runPrHead(context) {
  assertCondition(context.eventName === 'pull_request', 'MODE_INVALID', 'pr-head requires pull_request event');
  const number = exactPositiveInteger(Number(context.event.pull_request?.number ?? context.event.number), 'pull request number');
  const authority = await collectPullAuthority(context.api, number);
  assertCondition(authority.pull.state === 'open' && authority.pull.merged_at === null, 'PULL_STATE_INVALID', 'B0 PR must be open');
  assertCondition(git(['rev-parse', 'HEAD']) === authority.headSha, 'CHECKOUT_NOT_HEAD', 'checkout must be exact PR head');
  verifyNoReachableBootstrap(authority.baseSha);
  const run = await verifyCurrentRun(context.api, context, authority);
  const result = {
    schemaVersion: 1,
    mode: 'pr-head',
    repository: context.repository.fullName,
    pullRequest: number,
    reviewedHead: authority.headSha,
    reviewId: authority.review.id,
    reviewerGithubLogin: authority.review.user.login,
    ruleset: authority.ruleset.binding,
    verifierSha256: sha256(await context.api.content(PATHS.verifier, authority.headSha)),
    governanceAfterHash: authority.logResult.afterHash,
    githubAuthorityEvidenceRef: authorityEvidenceRef(authority),
    workflowRunId: run.id,
    workflowRunAttempt: run.run_attempt,
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
  const authority = await collectPullAuthority(context.api, pullSummary.number, { baseShaOverride: mergeParent });
  assertCondition(authority.pull.merged_at !== null && authority.pull.merge_commit_sha === policyCommit, 'PULL_STATE_INVALID', 'pull must be squash merged');
  verifyNoReachableBootstrap(mergeParent);

  for (const path of Object.keys(EXACT_OPERATIONS)) {
    const reviewedBytes = await context.api.content(path, authority.headSha);
    const mergedBytes = await context.api.content(path, policyCommit);
    assertCondition(reviewedBytes.equals(mergedBytes), 'POSTIMAGE_MISMATCH', path);
  }
  const passed = await verifyPassedB0Check(context.api, authority.headSha, authority.review, authority.ruleset.integrationId);
  assertCondition(
    Date.parse(authority.ruleset.updatedAt) <= Date.parse(String(passed.check.started_at)),
    'RULESET_CHANGED_AFTER_CHECK',
    'ruleset changed after passing check began',
  );
  const evidenceWithoutHash = {
    schemaVersion: 1,
    kind: 'B0_AGENT_REVIEWER_BOOTSTRAP',
    review: {
      ...authority.reviewBinding,
      githubAuthorityEvidenceRef: authorityEvidenceRef(authority, passed),
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
