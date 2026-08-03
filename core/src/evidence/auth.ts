import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type EvidenceAuthErrorCode =
  | 'signing_key_missing'
  | 'signing_key_permissions_mismatch'
  | 'run_metadata_missing'
  | 'run_metadata_permissions_mismatch'
  | 'run_metadata_malformed'
  | 'run_identity_mismatch'
  | 'public_key_fingerprint_mismatch'
  | 'signing_key_mismatch'
  | 'private_key_inside_worktree'
  | 'auth_already_initialized';

export class EvidenceAuthenticationError extends Error {
  readonly code: EvidenceAuthErrorCode;
  readonly reason: 'evidence_auth_unavailable' | 'evidence_auth_mismatch';

  constructor(
    code: EvidenceAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EvidenceAuthenticationError';
    this.code = code;
    this.reason =
      code === 'signing_key_missing' ||
      code === 'run_metadata_missing' ||
      code === 'signing_key_permissions_mismatch' ||
      code === 'run_metadata_permissions_mismatch'
        ? 'evidence_auth_unavailable'
        : 'evidence_auth_mismatch';
  }
}

export interface FrozenRunMetadata {
  version: 1;
  runId: string;
  evidenceAuth: {
    algorithm: 'Ed25519';
    publicKeyPem: string;
    publicKeyFingerprintSha256: string;
  };
}

export interface EvidenceAuthenticator {
  readonly runId: string;
  readonly publicKeyFingerprintSha256: string;
  readonly metadata: FrozenRunMetadata;
  sign(bytes: Uint8Array): string;
  verify(bytes: Uint8Array, signatureBase64: string): boolean;
}

export interface OpenEvidenceAuthenticatorOptions {
  runStateDir: string;
  runId: string;
  recovering: boolean;
  worktreeDirs?: string[];
}

function fingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex');
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function parseMetadata(bytes: Uint8Array): FrozenRunMetadata {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new EvidenceAuthenticationError(
      'run_metadata_malformed',
      `run metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EvidenceAuthenticationError('run_metadata_malformed', 'run metadata root must be an object');
  }
  const metadata = value as Partial<FrozenRunMetadata>;
  const auth = metadata.evidenceAuth as Partial<FrozenRunMetadata['evidenceAuth']> | undefined;
  if (
    metadata.version !== 1 ||
    typeof metadata.runId !== 'string' ||
    auth?.algorithm !== 'Ed25519' ||
    typeof auth.publicKeyPem !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(auth.publicKeyFingerprintSha256 ?? '')
  ) {
    throw new EvidenceAuthenticationError('run_metadata_malformed', 'run metadata has an invalid evidence-auth contract');
  }
  return metadata as FrozenRunMetadata;
}

function normalizeCanonical(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): null | boolean | number | string | unknown[] | Record<string, unknown> {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonical evidence number at ${path} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`unsupported canonical evidence value at ${path}: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError(`unsupported canonical evidence cycle at ${path}`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => normalizeCanonical(entry, `${path}[${index}]`, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`unsupported canonical evidence object at ${path}`);
    }
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      normalized[key] = normalizeCanonical(source[key], `${path}.${key}`, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

/** The only signed-byte encoding: UTF-8 JSON with recursively sorted object keys. */
export function canonicalEvidenceBytes(value: unknown): Uint8Array {
  const envelope = normalizeCanonical(
    { encoding: 'canonical-json-v1', value },
    '$',
    new Set<object>(),
  );
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function buildAuthenticator(
  runId: string,
  metadata: FrozenRunMetadata,
  privateKey: KeyObject,
  publicKey: KeyObject,
): EvidenceAuthenticator {
  return {
    runId,
    metadata,
    publicKeyFingerprintSha256: metadata.evidenceAuth.publicKeyFingerprintSha256,
    sign(bytes) {
      return signBytes(null, bytes, privateKey).toString('base64');
    },
    verify(bytes, signatureBase64) {
      try {
        const signature = Buffer.from(signatureBase64, 'base64');
        if (signature.length === 0 || signature.toString('base64') !== signatureBase64) return false;
        return verifyBytes(null, bytes, publicKey, signature);
      } catch {
        return false;
      }
    },
  };
}

export function openEvidenceAuthenticator(
  options: OpenEvidenceAuthenticatorOptions,
): EvidenceAuthenticator {
  const runStateDir = realpathSync(resolve(options.runStateDir));
  const authDir = join(runStateDir, 'evidence-auth');
  const metadataPath = join(runStateDir, 'run-metadata.json');
  const resolvedWorktrees = (options.worktreeDirs ?? []).map((worktree) => ({
    configured: worktree,
    resolved: realpathSync(resolve(worktree)),
  }));
  const assertPrivateOutsideWorktrees = (candidate: string): void => {
    for (const worktree of resolvedWorktrees) {
      if (isWithin(worktree.resolved, candidate)) {
        throw new EvidenceAuthenticationError(
          'private_key_inside_worktree',
          `run signing key path ${candidate} is inside agent worktree ${resolve(worktree.configured)}`,
        );
      }
    }
  };
  assertPrivateOutsideWorktrees(join(authDir, 'private-key.pem'));
  const hasMetadata = existsSync(metadataPath);
  if (!options.recovering && hasMetadata) {
    throw new EvidenceAuthenticationError(
      'auth_already_initialized',
      'new run authentication cannot replace existing signing material',
    );
  }
  if (!existsSync(authDir)) {
    if (options.recovering) {
      throw new EvidenceAuthenticationError(
        'signing_key_missing',
        `run signing key is missing: ${join(authDir, 'private-key.pem')}`,
      );
    }
    mkdirSync(authDir, { recursive: false, mode: 0o700 });
  }
  if (!lstatSync(authDir).isDirectory()) {
    throw new EvidenceAuthenticationError(
      'signing_key_mismatch',
      `run authentication path is not a regular directory: ${authDir}`,
    );
  }
  const privatePath = join(realpathSync(authDir), 'private-key.pem');
  assertPrivateOutsideWorktrees(privatePath);

  const hasPrivate = existsSync(privatePath);
  if (options.recovering) {
    if (!hasPrivate) {
      throw new EvidenceAuthenticationError('signing_key_missing', `run signing key is missing: ${privatePath}`);
    }
    if (!hasMetadata) {
      throw new EvidenceAuthenticationError('run_metadata_missing', `run metadata is missing: ${metadataPath}`);
    }
    if (!lstatSync(privatePath).isFile()) {
      throw new EvidenceAuthenticationError('signing_key_mismatch', `run signing key is not a regular file: ${privatePath}`);
    }
    if (!lstatSync(metadataPath).isFile()) {
      throw new EvidenceAuthenticationError('run_metadata_malformed', `run metadata is not a regular file: ${metadataPath}`);
    }
    if ((statSync(privatePath).mode & 0o777) !== 0o600) {
      throw new EvidenceAuthenticationError(
        'signing_key_permissions_mismatch',
        `run signing key must have mode 0600: ${privatePath}`,
      );
    }
    if ((statSync(metadataPath).mode & 0o777) !== 0o444) {
      throw new EvidenceAuthenticationError(
        'run_metadata_permissions_mismatch',
        `run metadata must have mode 0444: ${metadataPath}`,
      );
    }
    const metadata = parseMetadata(readFileSync(metadataPath));
    if (metadata.runId !== options.runId) {
      throw new EvidenceAuthenticationError(
        'run_identity_mismatch',
        `run metadata names ${metadata.runId}, expected ${options.runId}`,
      );
    }
    let metadataPublic: KeyObject;
    let privateKey: KeyObject;
    try {
      metadataPublic = createPublicKey(metadata.evidenceAuth.publicKeyPem);
      privateKey = createPrivateKey(readFileSync(privatePath));
    } catch (error) {
      throw new EvidenceAuthenticationError(
        'signing_key_mismatch',
        `run signing material is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const metadataFingerprint = fingerprint(metadataPublic);
    if (metadataFingerprint !== metadata.evidenceAuth.publicKeyFingerprintSha256) {
      throw new EvidenceAuthenticationError(
        'public_key_fingerprint_mismatch',
        `frozen public key fingerprint is ${metadataFingerprint}, metadata records ${metadata.evidenceAuth.publicKeyFingerprintSha256}`,
      );
    }
    const privatePublic = createPublicKey({
      key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
      format: 'pem',
    });
    if (fingerprint(privatePublic) !== metadataFingerprint) {
      throw new EvidenceAuthenticationError('signing_key_mismatch', 'run private key does not match frozen public key');
    }
    return buildAuthenticator(options.runId, metadata, privateKey, metadataPublic);
  }

  if (hasPrivate || hasMetadata) {
    throw new EvidenceAuthenticationError(
      'auth_already_initialized',
      'new run authentication cannot replace existing signing material',
    );
  }
  const generated = generateKeyPairSync('ed25519');
  const publicKeyPem = generated.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const metadata: FrozenRunMetadata = {
    version: 1,
    runId: options.runId,
    evidenceAuth: {
      algorithm: 'Ed25519',
      publicKeyPem,
      publicKeyFingerprintSha256: fingerprint(generated.publicKey),
    },
  };
  writeFileSync(
    privatePath,
    generated.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { flag: 'wx', mode: 0o600 },
  );
  chmodSync(privatePath, 0o600);
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o444,
  });
  chmodSync(metadataPath, 0o444);
  return buildAuthenticator(options.runId, metadata, generated.privateKey, generated.publicKey);
}
