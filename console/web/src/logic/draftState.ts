export interface DraftEntry {
  readonly resourceKey: string;
  readonly content: string;
  readonly baseHash: string | null;
  readonly sensitivity: 'non-sensitive';
}

export interface SensitiveMemoryEntry {
  readonly resourceKey: string;
  readonly content: string;
  readonly sensitivity: 'sensitive';
}

export type ClientMemoryEntry = DraftEntry | SensitiveMemoryEntry;

export function upsertDraft(current: readonly DraftEntry[], draft: DraftEntry): readonly DraftEntry[] {
  return [...current.filter((entry) => entry.resourceKey !== draft.resourceKey), draft];
}

export function removeDraft(current: readonly DraftEntry[], resourceKey: string): readonly DraftEntry[] {
  return current.filter((entry) => entry.resourceKey !== resourceKey);
}

export function retainAfterAuthLoss(current: readonly ClientMemoryEntry[]): readonly DraftEntry[] {
  return current.filter((entry): entry is DraftEntry => entry.sensitivity === 'non-sensitive');
}

export function reconcileAuthoritative<T>(
  clientProjection: T,
  serverProjection: T,
  equal: (left: T, right: T) => boolean = Object.is,
): { readonly value: T; readonly refreshed: boolean } {
  return { value: serverProjection, refreshed: !equal(clientProjection, serverProjection) };
}
