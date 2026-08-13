import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { removeDraft, retainAfterAuthLoss, upsertDraft, type DraftEntry } from './logic/draftState.ts';

interface DraftMemory {
  readonly drafts: readonly DraftEntry[];
  readonly save: (draft: DraftEntry) => void;
  readonly remove: (resourceKey: string) => void;
}

const DraftContext = createContext<DraftMemory | null>(null);

export function DraftProvider({ authVerified, children }: { authVerified: boolean; children: ReactNode }): React.JSX.Element {
  const [drafts, setDrafts] = useState<readonly DraftEntry[]>([]);

  useEffect(() => {
    if (!authVerified) setDrafts((current) => retainAfterAuthLoss(current));
  }, [authVerified]);

  return (
    <DraftContext.Provider
      value={{
        drafts,
        save: (draft) => setDrafts((current) => upsertDraft(current, draft)),
        remove: (resourceKey) => setDrafts((current) => removeDraft(current, resourceKey)),
      }}
    >
      {children}
    </DraftContext.Provider>
  );
}

export function useDraftMemory(): DraftMemory {
  const value = useContext(DraftContext);
  if (value === null) throw new Error('useDraftMemory must be used within DraftProvider');
  return value;
}
