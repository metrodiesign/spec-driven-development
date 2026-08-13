export interface MutationIdentity {
  readonly action: string;
  readonly target: string;
  readonly concurrencyKey: string | null;
}

export function mutationIdentityKey(identity: MutationIdentity): string {
  return JSON.stringify([identity.action, identity.target, identity.concurrencyKey]);
}

export function claimMutation(pending: Set<string>, identity: MutationIdentity): boolean {
  const key = mutationIdentityKey(identity);
  if (pending.has(key)) return false;
  pending.add(key);
  return true;
}

export function releaseMutation(pending: Set<string>, identity: MutationIdentity): void {
  pending.delete(mutationIdentityKey(identity));
}

export function destructiveConfirmationText(action: string, target: string): string {
  return `${action}\nTarget: ${target}\nContinue?`;
}
