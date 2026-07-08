// _template.ts smoke (REQ-3.3): the non-registered skeleton composes the wire helpers
// into a working AdapterInterface — a real starting point, not dead boilerplate.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTemplateAdapter } from './_template.ts';
import type { AgentRequest } from 'aal';

function req(): AgentRequest {
  return {
    requestId: 'r-1',
    agentRole: 'implementer',
    taskContract: { goalId: 'G', title: 't', objective: 'fix', acceptanceCriteria: [] },
    contextBundle: { pieces: [], canaryToken: 'C', stats: { bytes: 0, pieceCount: 0 } },
    manifestRef: 'blob://m',
    outputSchema: {},
    toolDefs: [],
    budget: { costUnits: 10 },
  };
}

test('the template adapter composes wire helpers into a valid AgentResponse', async () => {
  const blobs = new Map<string, string>();
  const adapter = createTemplateAdapter({
    id: 'example',
    lineage: 'example-vendor',
    model: 'ex-1',
    putEvidence: (c) => { const ref = `blob://${blobs.size}`; blobs.set(ref, c); return ref; },
    transport: () => Promise.resolve({
      text: JSON.stringify({ claim: 'READY_FOR_VERIFICATION', actionRequests: [{ type: 'WRITE_FILE', path: 'a.txt', content: 'x' }] }),
      tokens: 2000,
    }),
  });
  const m = adapter.manifest();
  assert.equal(m.lineage, 'example-vendor');
  assert.equal(m.executionBackend, false);
  const resp = await adapter.send(req());
  assert.equal((resp.structuredResult as { claim?: string }).claim, 'READY_FOR_VERIFICATION');
  assert.equal(resp.actionRequests[0]?.type, 'WRITE_FILE');
  assert.ok((resp.actionRequests[0] as { contentRef?: string }).contentRef?.startsWith('blob://'));
  assert.equal(resp.usage.costUnits, 2, '2000/1000');
});
