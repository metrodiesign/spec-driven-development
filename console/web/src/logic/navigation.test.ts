import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeRoute, encodeRoute, routeForArea, validateSelectedItem, type RouteState } from './navigation.ts';

test('route codec round-trips only allowlisted area, view, project, and item fields (REQ-1.4/1.5/1.11)', () => {
  const route: RouteState = { area: 'console', view: 'terminal', project: '-Users-project', item: 'mcp-authenticate' };
  assert.deepEqual(decodeRoute(encodeRoute(route)), { route, warning: null });
});

test('route codec ignores arbitrary and secret-bearing query fields (REQ-1.11/1.12)', () => {
  const decoded = decodeRoute('?area=core&view=runs&item=run-1&token=secret&confirmToken=secret&draft=secret');
  assert.deepEqual(decoded.route, { area: 'core', view: 'runs', project: null, item: 'run-1' });
  const encoded = encodeRoute({ ...decoded.route, credential: 'secret' } as RouteState & { credential: string });
  assert.equal(encoded, '?area=core&view=runs&item=run-1');
  assert.doesNotMatch(encoded, /secret|token|draft/u);
});

test('invalid area recovers to Dashboard with a visible-warning payload (REQ-1.6)', () => {
  assert.deepEqual(decodeRoute('?area=missing&view=runs'), {
    route: { area: 'dashboard', view: null, project: null, item: null },
    warning: { kind: 'invalid-area', value: 'missing' },
  });
});

test('invalid item keeps area/view and produces an empty-inspector warning (REQ-1.9)', () => {
  const decoded = decodeRoute('?area=aal&view=routing&item=missing');
  assert.deepEqual(validateSelectedItem(decoded, ['planner', 'reviewer']), {
    route: { area: 'aal', view: 'routing', project: null, item: null },
    warning: { kind: 'invalid-item', value: 'missing' },
  });
});

test('unknown item list defers validation; Back/Forward decode remains side-effect free (REQ-1.9/1.10)', () => {
  const decoded = decodeRoute('?area=adapters&view=catalog&item=codex');
  assert.equal(validateSelectedItem(decoded, null), decoded);
  assert.deepEqual(decodeRoute(encodeRoute(decoded.route)), decoded);
});

test('changing area clears selected view/item but preserves project context', () => {
  assert.deepEqual(
    routeForArea({ area: 'console', view: 'terminal', project: 'project-1', item: 'mcp-authenticate' }, 'core'),
    { area: 'core', view: null, project: 'project-1', item: null },
  );
});
