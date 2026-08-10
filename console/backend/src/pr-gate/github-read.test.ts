import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGitHubPullRequestReader } from './github-read.ts';

test('GitHub read port binds descriptor/current head and keeps token in request header only', async () => {
  const mergeCommitSha = 'c'.repeat(40);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reader = createGitHubPullRequestReader({
    token: 'read-credential',
    fetch: async (url, init) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return new Response(JSON.stringify({
        title: 'PR', body: 'body', base: { ref: 'main', sha: 'a'.repeat(40) },
        head: { sha: 'b'.repeat(40), repo: { full_name: 'fork/repo' } },
        merge_commit_sha: mergeCommitSha,
      }), { status: 200 });
    },
  });
  const descriptor = await reader.getPullRequest('acme/repo', 7);
  assert.equal(descriptor.fromFork, true);
  assert.equal(await reader.getCurrentHead('acme/repo', 7), 'b'.repeat(40));
  assert.equal((await reader.getWorkflowPullRequest('acme/repo', 7, mergeCommitSha)).headSha, 'b'.repeat(40));
  await assert.rejects(reader.getWorkflowPullRequest('acme/repo', 7, 'd'.repeat(40)), /not bound/u);
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, 'Bearer read-credential');
  assert.ok(!calls[0]?.url.includes('read-credential'));
});
