import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { I18nProvider, useI18n } from './I18nContext.tsx';
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

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  override state = { hasError: false };
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  override componentDidCatch(error: unknown): void {
    console.error(error);
  }
  override render(): ReactNode {
    return this.state.hasError ? <ErrorFallback /> : this.props.children;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
