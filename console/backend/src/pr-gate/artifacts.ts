import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  canonicalEvidenceBytes,
  createEvidenceStore,
  openEvidenceAuthenticator,
  type EvidenceAuthenticator,
  type EvidenceStore,
  type Sha256Ref,
} from 'core';

interface SignedEnvelope {
  schemaVersion: 1;
  runId: string;
  kind: string;
  payload: unknown;
  contentHash: Sha256Ref;
  keyFingerprint: string;
  signatureBase64: string;
}

export interface PrGateArtifactSession {
  put(kind: string, payload: unknown): Sha256Ref;
  get<T = unknown>(ref: Sha256Ref, expectedKind?: string): T;
}

function hash(bytes: Uint8Array): Sha256Ref {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function blobRef(ref: Sha256Ref): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(ref)) throw new Error(`invalid PR gate artifact ref: ${ref}`);
  return `blob://${ref.slice('sha256:'.length)}`;
}

function signedBytes(envelope: Omit<SignedEnvelope, 'signatureBase64'>): Uint8Array {
  return canonicalEvidenceBytes(envelope);
}

export function createPrGateArtifactSession(input: {
  runId: string;
  evidence: EvidenceStore;
  authenticator: EvidenceAuthenticator;
}): PrGateArtifactSession {
  if (input.authenticator.runId !== input.runId) throw new Error('artifact authenticator run identity mismatch');
  return {
    put(kind, payload) {
      const payloadBytes = canonicalEvidenceBytes(payload);
      const unsigned: Omit<SignedEnvelope, 'signatureBase64'> = {
        schemaVersion: 1,
        runId: input.runId,
        kind,
        payload,
        contentHash: hash(payloadBytes),
        keyFingerprint: input.authenticator.publicKeyFingerprintSha256,
      };
      const envelope: SignedEnvelope = { ...unsigned, signatureBase64: input.authenticator.sign(signedBytes(unsigned)) };
      const stored = input.evidence.put(canonicalEvidenceBytes(envelope));
      return `sha256:${stored.slice('blob://'.length)}`;
    },
    get<T>(ref: Sha256Ref, expectedKind?: string): T {
      const bytes = input.evidence.get(blobRef(ref));
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error(`PR gate artifact ${ref} is not canonical JSON`);
      }
      const canonical = (parsed as { value?: unknown }).value;
      if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) throw new Error(`PR gate artifact ${ref} has invalid envelope`);
      const envelope = canonical as SignedEnvelope;
      if (
        envelope.schemaVersion !== 1 ||
        envelope.runId !== input.runId ||
        typeof envelope.kind !== 'string' ||
        typeof envelope.signatureBase64 !== 'string' ||
        envelope.keyFingerprint !== input.authenticator.publicKeyFingerprintSha256
      ) {
        throw new Error(`PR gate artifact ${ref} identity mismatch`);
      }
      if (expectedKind !== undefined && envelope.kind !== expectedKind) throw new Error(`PR gate artifact ${ref} kind mismatch`);
      if (hash(canonicalEvidenceBytes(envelope.payload)) !== envelope.contentHash) throw new Error(`PR gate artifact ${ref} content hash mismatch`);
      const { signatureBase64, ...unsigned } = envelope;
      if (!input.authenticator.verify(signedBytes(unsigned), signatureBase64)) throw new Error(`PR gate artifact ${ref} signature mismatch`);
      return envelope.payload as T;
    },
  };
}

export function openFilePrGateArtifactSession(input: {
  stateRoot: string;
  runId: string;
  recovering: boolean;
  worktreeDirs?: string[];
}): PrGateArtifactSession {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(input.runId)) throw new Error(`invalid PR gate run id: ${input.runId}`);
  const stateRoot = resolve(input.stateRoot);
  mkdirSync(stateRoot, { recursive: true });
  const runStateDir = join(stateRoot, input.runId);
  if (input.recovering) {
    if (!existsSync(runStateDir)) throw new Error(`PR gate run state missing: ${input.runId}`);
  } else {
    mkdirSync(runStateDir, { recursive: false, mode: 0o700 });
  }
  const evidence = createEvidenceStore(join(runStateDir, 'evidence'));
  const authenticator = openEvidenceAuthenticator({
    runStateDir,
    runId: input.runId,
    recovering: input.recovering,
    ...(input.worktreeDirs === undefined ? {} : { worktreeDirs: input.worktreeDirs }),
  });
  return createPrGateArtifactSession({ runId: input.runId, evidence, authenticator });
}
