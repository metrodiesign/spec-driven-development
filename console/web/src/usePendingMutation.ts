import { useCallback, useRef, useState } from 'react';

import {
  claimMutation,
  mutationIdentityKey,
  releaseMutation,
  type MutationIdentity,
} from './logic/mutation.ts';

export function usePendingMutation(): {
  readonly isPending: (identity: MutationIdentity) => boolean;
  readonly run: <T>(identity: MutationIdentity, action: () => Promise<T>) => Promise<T | undefined>;
} {
  const pending = useRef(new Set<string>());
  const [, render] = useState(0);

  return {
    isPending: useCallback((identity) => pending.current.has(mutationIdentityKey(identity)), []),
    run: useCallback(async <T,>(identity: MutationIdentity, action: () => Promise<T>): Promise<T | undefined> => {
      if (!claimMutation(pending.current, identity)) return undefined;
      render((value) => value + 1);
      try {
        return await action();
      } finally {
        releaseMutation(pending.current, identity);
        render((value) => value + 1);
      }
    }, []),
  };
}
