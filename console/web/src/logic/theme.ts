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

/**
 * Button label key (REQ-22) names the theme a click switches TO, not the
 * current one. Returns an i18n LocaleKey literal, not English text — App.tsx
 * resolves it through t(). The two literals here are structurally checked
 * against logic/i18n.ts's LocaleKey union at the App.tsx call site.
 */
export function themeToggleLabel(current: Theme): 'themeToggleToDark' | 'themeToggleToLight' {
  return current === 'dark' ? 'themeToggleToLight' : 'themeToggleToDark';
}
