// React context + hook wiring for i18n (REQ-22.2): owns the DOM/localStorage/
// navigator side effects — same split as App.tsx's useTheme() over
// logic/theme.ts. Pure dictionary/resolution logic lives in logic/i18n.ts.

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { isLocale, resolveInitialLocale, toggleLocale, translate, LOCALE_STORAGE_KEY, type Locale, type LocaleKey } from './logic/i18n.ts';
import { readPreference, writePreference } from './logic/preferences.ts';

interface I18nValue {
  locale: Locale;
  t: (key: LocaleKey, params?: Record<string, string | number>) => string;
  onToggleLocale: () => void;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    const attr = document.documentElement.getAttribute('data-locale');
    if (isLocale(attr)) return attr;
    const stored = readPreference(localStorage, LOCALE_STORAGE_KEY);
    return resolveInitialLocale(stored, navigator.language.toLowerCase().startsWith('th'));
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-locale', locale);
    document.documentElement.lang = locale;
    writePreference(localStorage, LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const value: I18nValue = {
    locale,
    t: (key, params) => translate(locale, key, params),
    onToggleLocale: () => setLocale(toggleLocale),
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (ctx === null) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
