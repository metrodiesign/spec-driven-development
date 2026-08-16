export const AREAS = ['dashboard', 'core', 'aal', 'adapters', 'console'] as const;

export type Area = (typeof AREAS)[number];

export interface RouteState {
  readonly area: Area;
  readonly view: string | null;
  readonly project: string | null;
  readonly item: string | null;
}

export type RouteWarning =
  | { readonly kind: 'invalid-area'; readonly value: string }
  | { readonly kind: 'invalid-view'; readonly value: string }
  | { readonly kind: 'invalid-item'; readonly value: string };

export interface DecodedRoute {
  readonly route: RouteState;
  readonly warning: RouteWarning | null;
}

const VIEWS: Readonly<Record<Area, readonly string[]>> = {
  dashboard: ['overview'],
  core: ['runs'],
  aal: ['routing', 'fusion'],
  adapters: ['catalog'],
  console: [
    'projects',
    'sessions',
    'terminal',
    'chat',
    'runs',
    'scheduler',
    'issues',
    'pr-quality',
    'governance',
    'system',
    'usage',
  ],
};

function isArea(value: string | null): value is Area {
  return value !== null && (AREAS as readonly string[]).includes(value);
}

function cleanIdentifier(value: string | null): string | null {
  if (value === null || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

export function isView(area: Area, value: string | null): value is string {
  return value !== null && VIEWS[area].includes(value);
}

export function decodeRoute(search: string): DecodedRoute {
  const params = new URLSearchParams(search);
  const rawArea = params.get('area');
  const area: Area = isArea(rawArea) ? rawArea : 'dashboard';
  let warning: RouteWarning | null =
    rawArea !== null && !isArea(rawArea) ? { kind: 'invalid-area', value: rawArea } : null;

  const rawView = cleanIdentifier(params.get('view'));
  const view = isView(area, rawView) ? rawView : null;
  if (warning === null && rawView !== null && view === null) {
    warning = { kind: 'invalid-view', value: rawView };
  }

  return {
    route: {
      area,
      view,
      project: cleanIdentifier(params.get('project')),
      item: cleanIdentifier(params.get('item')),
    },
    warning,
  };
}

export function encodeRoute(route: RouteState): string {
  const params = new URLSearchParams();
  params.set('area', route.area);
  if (isView(route.area, route.view)) params.set('view', route.view);
  const project = cleanIdentifier(route.project);
  const item = cleanIdentifier(route.item);
  if (project !== null) params.set('project', project);
  if (item !== null) params.set('item', item);
  return `?${params.toString()}`;
}

export function validateSelectedItem(decoded: DecodedRoute, availableItems: readonly string[] | null): DecodedRoute {
  const item = decoded.route.item;
  if (item === null || availableItems === null || availableItems.includes(item)) return decoded;
  return {
    route: { ...decoded.route, item: null },
    warning: { kind: 'invalid-item', value: item },
  };
}

export function routeForArea(current: RouteState, area: Area): RouteState {
  return { area, view: null, project: current.project, item: null };
}
