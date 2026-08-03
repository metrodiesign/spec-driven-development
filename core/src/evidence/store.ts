// Content-addressed immutable evidence store (INV-10, REQ-4). Only core writes.
// Also serves as the blob store Action refs point into (WRITE_FILE.contentRef).

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export type EvidenceStoreErrorCode =
  | 'invalid_ref'
  | 'missing_blob'
  | 'hash_mismatch'
  | 'existing_blob_mismatch';

export class EvidenceStoreError extends Error {
  readonly code: EvidenceStoreErrorCode;

  constructor(
    code: EvidenceStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceStoreError';
    this.code = code;
  }
}

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
  if (!ref.startsWith(REF_PREFIX)) {
    throw new EvidenceStoreError('invalid_ref', `invalid evidence ref: ${ref}`);
  }
  const hash = ref.slice(REF_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new EvidenceStoreError('invalid_ref', `invalid evidence ref: ${ref}`);
  }
  return join(dir, hash);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function readRegularFileNoFollow(path: string): Uint8Array {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`evidence path is not a regular file: ${path}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createEvidenceStore(dir: string): EvidenceStore {
  mkdirSync(dir, { recursive: true });

  return {
    put(content) {
      // Freeze caller-owned bytes before hashing so a shared/mutable view cannot
      // change between address derivation and exclusive publication.
      const bytes = typeof content === 'string'
        ? new TextEncoder().encode(content)
        : Uint8Array.from(content);
      const hash = sha256Hex(bytes);
      const path = join(dir, hash);
      try {
        // `wx` is the publication linearization point. A competing writer can only
        // win the exclusive create; losers verify the already-published bytes.
        writeFileSync(path, bytes, { flag: 'wx' });
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        if (errno.code !== 'EEXIST') throw error;
        let existing: Uint8Array;
        try {
          existing = readRegularFileNoFollow(path);
        } catch (readError) {
          throw new EvidenceStoreError(
            'existing_blob_mismatch',
            `existing evidence is not a readable regular file for ${REF_PREFIX}${hash}: ${readError instanceof Error ? readError.message : String(readError)}`,
          );
        }
        const existingHash = sha256Hex(existing);
        if (existingHash !== hash || !sameBytes(existing, bytes)) {
          throw new EvidenceStoreError(
            'existing_blob_mismatch',
            `existing evidence mismatch for ${REF_PREFIX}${hash}: content hashes to ${existingHash}`,
          );
        }
      }
      return `${REF_PREFIX}${hash}`;
    },

    get(ref) {
      const path = refToPath(dir, ref);
      let bytes: Uint8Array;
      try {
        bytes = readRegularFileNoFollow(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new EvidenceStoreError('missing_blob', `missing evidence blob for ${ref}`);
        }
        throw new EvidenceStoreError(
          'hash_mismatch',
          `evidence blob is not a readable regular file for ${ref}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const actual = sha256Hex(bytes);
      const expected = ref.slice(REF_PREFIX.length);
      if (actual !== expected) {
        throw new EvidenceStoreError(
          'hash_mismatch',
          `evidence hash mismatch for ${ref}: content hashes to ${actual}`,
        );
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
