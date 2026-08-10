import type { PullRequestDescriptor, RepositoryId } from 'core';

import type { PullRequestReadPort } from './manager.ts';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function repoPath(repository: RepositoryId): string {
  const [owner, name, extra] = repository.split('/');
  if (!owner || !name || extra !== undefined) throw new Error(`invalid GitHub repository: ${repository}`);
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub pull request response is invalid');
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`GitHub pull request ${field} is missing`);
  return value;
}

export interface GitHubPullRequestReader extends PullRequestReadPort {
  getWorkflowPullRequest(repository: RepositoryId, number: number, sourceWorkflowHeadSha: string): Promise<PullRequestDescriptor>;
}

export function createGitHubPullRequestReader(input: {
  token?: string;
  apiBaseUrl?: string;
  fetch?: FetchLike;
}): GitHubPullRequestReader {
  const fetcher = input.fetch ?? fetch;
  const base = (input.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/u, '');

  const read = async (repository: RepositoryId, number: number): Promise<{ descriptor: PullRequestDescriptor; mergeCommitSha: string }> => {
    if (!Number.isInteger(number) || number <= 0) throw new Error('invalid pull request number');
    const response = await fetcher(`${base}/repos/${repoPath(repository)}/pulls/${number}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
      },
    });
    if (!response.ok) throw new Error(`GitHub Pulls API failed with HTTP ${response.status}`);
    const root = object(await response.json());
    const baseInfo = object(root['base']);
    const headInfo = object(root['head']);
    const headRepo = object(headInfo['repo']);
    return {
      descriptor: {
        repository,
        number,
        title: string(root['title'], 'title'),
        description: typeof root['body'] === 'string' ? root.body : '',
        baseRef: string(baseInfo['ref'], 'base.ref'),
        baseSha: string(baseInfo['sha'], 'base.sha'),
        headSha: string(headInfo['sha'], 'head.sha'),
        fromFork: string(headRepo['full_name'], 'head.repo.full_name') !== repository,
      },
      mergeCommitSha: string(root['merge_commit_sha'], 'merge_commit_sha'),
    };
  };

  return {
    async getPullRequest(repository, number) { return (await read(repository, number)).descriptor; },
    async getCurrentHead(repository, number) { return (await read(repository, number)).descriptor.headSha; },
    async getWorkflowPullRequest(repository, number, sourceWorkflowHeadSha) {
      if (!/^[0-9a-f]{40,64}$/u.test(sourceWorkflowHeadSha)) throw new Error('invalid source workflow head SHA');
      const result = await read(repository, number);
      if (result.mergeCommitSha !== sourceWorkflowHeadSha) throw new Error('workflow run is not bound to the declared pull request');
      return result.descriptor;
    },
  };
}
