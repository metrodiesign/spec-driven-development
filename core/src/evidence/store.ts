// Content-addressed immutable evidence store (INV-10, REQ-4). Only core writes.
// Also serves as the blob store Action refs point into (WRITE_FILE.contentRef).

export interface EvidenceStore {
  /** Store bytes, return a `blob://<sha256>` ref. */
  put(content: string | Uint8Array): string;
  /** Fetch and VERIFY against the address; a hash mismatch throws (REQ-4.3). */
  get(ref: string): Uint8Array;
  getText(ref: string): string;
  has(ref: string): boolean;
}

export function createEvidenceStore(_dir: string): EvidenceStore {
  throw new Error('NotImplemented: createEvidenceStore');
}
