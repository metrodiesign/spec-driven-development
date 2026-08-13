import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reconcileAuthoritative, removeDraft, retainAfterAuthLoss, upsertDraft, type ClientMemoryEntry } from './draftState.ts';

test('draft memory replaces by resource key and never needs browser storage', () => {
  const first = upsertDraft([], {
    resourceKey: 'settings/project-1',
    content: 'first',
    baseHash: 'hash-1',
    sensitivity: 'non-sensitive',
  });
  const replaced = upsertDraft(first, {
    resourceKey: 'settings/project-1',
    content: 'second',
    baseHash: 'hash-1',
    sensitivity: 'non-sensitive',
  });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.content, 'second');
  assert.deepEqual(removeDraft(replaced, 'settings/project-1'), []);
});

test('auth loss retains only declared non-sensitive drafts and clears credentials/secrets (REQ-8.16/8.17)', () => {
  const entries: ClientMemoryEntry[] = [
    { resourceKey: 'settings/project-1', content: 'safe draft', baseHash: null, sensitivity: 'non-sensitive' },
    { resourceKey: 'mcp/test-secret', content: 'secret', sensitivity: 'sensitive' },
  ];
  assert.deepEqual(retainAfterAuthLoss(entries), [entries[0]]);
});

test('authoritative server projection wins and reports client conflict (REQ-8.14)', () => {
  assert.deepEqual(reconcileAuthoritative('client-old', 'server-current'), {
    value: 'server-current',
    refreshed: true,
  });
  assert.deepEqual(reconcileAuthoritative('same', 'same'), { value: 'same', refreshed: false });
});
