// Pure theme resolution/toggle logic (REQ-20). The view (App.tsx) owns the
// DOM/localStorage/matchMedia side effects — same split as logic/auth.ts.

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'console-theme';

export function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark';
}

/** WHEN no preference is stored, follow prefers-color-scheme (REQ-20.2). */
export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (isTheme(stored)) return stored;
  return prefersDark ? 'dark' : 'light';
}

/** A stored/toggled choice wins over the media default in both directions (REQ-20.2). */
export function toggleTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

/** Button label names the theme a click switches TO, not the current one. */
export function themeToggleLabel(current: Theme): string {
  return current === 'dark' ? 'Light mode' : 'Dark mode';
}
