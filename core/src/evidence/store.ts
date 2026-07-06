// Content-addressed immutable evidence store (INV-10, REQ-4). Only core writes.
// Also serves as the blob store Action refs point into (WRITE_FILE.contentRef).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface EvidenceStore {
  /** Store bytes, return a `blob://<sha256>` ref. */
  put(content: string | Uint8Array): string;
  /** Fetch and VERIFY against the address; a hash mismatch throws (REQ-4.3). */
  get(ref: string): Uint8Array;
  getText(ref: string): string;
  has(ref: string): boolean;
}

const REF_PREFIX = 'blob://';

function sha256Hex(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function refToPath(dir: string, ref: string): string {
  if (!ref.startsWith(REF_PREFIX)) throw new Error(`invalid evidence ref: ${ref}`);
  const hash = ref.slice(REF_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid evidence ref: ${ref}`);
  return join(dir, hash);
}

export function createEvidenceStore(dir: string): EvidenceStore {
  mkdirSync(dir, { recursive: true });

  return {
    put(content) {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const hash = sha256Hex(bytes);
      const path = join(dir, hash);
      // Content-addressed: identical content = identical path; never overwritten.
      if (!existsSync(path)) writeFileSync(path, bytes);
      return `${REF_PREFIX}${hash}`;
    },

    get(ref) {
      const path = refToPath(dir, ref);
      const bytes = readFileSync(path);
      const actual = sha256Hex(bytes);
      const expected = ref.slice(REF_PREFIX.length);
      if (actual !== expected) {
        throw new Error(`evidence hash mismatch for ${ref}: content hashes to ${actual}`);
      }
      return bytes;
    },

    getText(ref) {
      return new TextDecoder().decode(this.get(ref));
    },

    has(ref) {
      try {
        return existsSync(refToPath(dir, ref));
      } catch {
        return false;
      }
    },
  };
}
