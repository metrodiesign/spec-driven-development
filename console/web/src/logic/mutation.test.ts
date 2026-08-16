import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  claimMutation,
  destructiveConfirmationText,
  mutationIdentityKey,
  releaseMutation,
  type MutationIdentity,
} from './mutation.ts';

test('same action, target, and concurrency key can be pending only once (REQ-8.8)', () => {
  const identity: MutationIdentity = { action: 'run-kill', target: 'RUN-1', concurrencyKey: null };
  const pending = new Set<string>();
  assert.equal(claimMutation(pending, identity), true);
  assert.equal(claimMutation(pending, identity), false);
  assert.equal(mutationIdentityKey(identity), '["run-kill","RUN-1",null]');
  releaseMutation(pending, identity);
  assert.equal(claimMutation(pending, identity), true);
});

test('destructive confirmation includes exact action and technical target (REQ-8.19)', () => {
  const text = destructiveConfirmationText('Cancel PR run', 'PRQ-42');
  assert.match(text, /Cancel PR run/u);
  assert.match(text, /PRQ-42/u);
});
