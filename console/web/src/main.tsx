import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { I18nProvider, useI18n } from './I18nContext.tsx';
import { isLocale, translate } from './logic/i18n.ts';
import './styles.css';

// Defense-in-depth (bugfix-console-fetch-status F6/F7): a render-time throw
// anywhere in the tree used to unmount the whole SPA — no boundary existed at
// all. This is deliberately generic (catches any future throw, not only the
// fetch-status crashes task 1 fixed at the source). Fallback text is a
// function component (not the class itself) so it can still call t() — a
// class component's render() can't use hooks directly.
function ErrorFallback(): React.JSX.Element {
  const { t } = useI18n();
  return <p role="alert">{t('appErrorBoundaryFallback')}</p>;
}

function StaticErrorFallback(): React.JSX.Element {
  const attr = document.documentElement.getAttribute('data-locale');
  return <p role="alert">{translate(isLocale(attr) ? attr : 'en', 'appErrorBoundaryFallback')}</p>;
}

class ErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    {/* Outer boundary has no i18n dependency: it is the only thing that can
        catch a throw from I18nProvider's OWN initialization (e.g. localStorage
        access denied in Safari private mode / a storage-partitioned iframe) —
        the inner boundary can't, since it's I18nProvider's descendant. */}
    <ErrorBoundary fallback={<StaticErrorFallback />}>
      <I18nProvider>
        <ErrorBoundary fallback={<ErrorFallback />}>
          <App />
        </ErrorBoundary>
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
);
