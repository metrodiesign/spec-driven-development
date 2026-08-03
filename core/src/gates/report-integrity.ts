import { createHash } from 'node:crypto';

import {
  canonicalEvidenceBytes,
  type EvidenceAuthenticator,
} from '../evidence/auth.ts';
import {
  EvidenceStoreError,
  type EvidenceStore,
} from '../evidence/store.ts';
import type {
  AuthenticatedGateReport,
  GateReport,
  GateReportEvidenceHash,
} from '../types.ts';

export type ReportIntegrityErrorCode =
  | 'report_malformed'
  | 'report_identity_mismatch'
  | 'artifact_identity_missing'
  | 'artifact_identity_mismatch'
  | 'evidence_reference_missing'
  | 'evidence_reference_invalid'
  | 'evidence_blob_missing'
  | 'evidence_hash_mismatch'
  | 'content_hash_missing'
  | 'content_hash_mismatch'
  | 'signature_missing'
  | 'signature_mismatch'
  | 'public_key_fingerprint_mismatch';

export class ReportIntegrityError extends Error {
  readonly code: ReportIntegrityErrorCode;
  readonly reason: 'evidence_auth_unavailable' | 'evidence_auth_mismatch';

  constructor(
    code: ReportIntegrityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReportIntegrityError';
    this.code = code;
    this.reason =
      code === 'evidence_blob_missing' || code === 'evidence_reference_missing'
        ? 'evidence_auth_unavailable'
        : 'evidence_auth_mismatch';
  }
}

export interface GateReportIdentity {
  runId: string;
  taskId: string;
}

export interface ReportIntegrity {
  signGateReport(report: GateReport, identity: GateReportIdentity): AuthenticatedGateReport;
  verifyGateReport(report: GateReport, identity: GateReportIdentity): AuthenticatedGateReport;
  verifyGateReportRef(ref: string, identity: GateReportIdentity): AuthenticatedGateReport;
  verifyEvidenceRef(ref: string): Uint8Array;
}

export interface ReportIntegrityOptions {
  evidence: EvidenceStore;
  authenticator: EvidenceAuthenticator;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asAuthenticated(report: GateReport): AuthenticatedGateReport {
  return report as AuthenticatedGateReport;
}

function withoutAuth(report: AuthenticatedGateReport): Record<string, unknown> {
  const copy = { ...report } as Record<string, unknown>;
  delete copy['auth'];
  return copy;
}

function signedBytes(
  report: AuthenticatedGateReport,
  evidence: GateReportEvidenceHash[],
): Uint8Array {
  return canonicalEvidenceBytes({
    version: 'gate-report-v1',
    report: withoutAuth(report),
    evidence,
  });
}

function validateReportShape(report: AuthenticatedGateReport): void {
  if (
    typeof report.runId !== 'string' || report.runId.length === 0 ||
    typeof report.taskId !== 'string' || report.taskId.length === 0 ||
    !['T0', 'T1', 'T2', 'T3'].includes(report.tier) ||
    (report.pass !== true && report.pass !== false && report.pass !== 'not_enabled') ||
    typeof report.gateConfigHash !== 'string' ||
    typeof report.commitHash !== 'string' ||
    typeof report.worktreeHash !== 'string' ||
    typeof report.envHash !== 'string' ||
    typeof report.scopeNote !== 'string' ||
    !Array.isArray(report.checks)
  ) {
    throw new ReportIntegrityError('report_malformed', 'gate report is missing required signed metadata');
  }
}

function mapStoreError(error: unknown, ref: string): ReportIntegrityError {
  if (error instanceof EvidenceStoreError) {
    if (error.code === 'missing_blob') {
      return new ReportIntegrityError('evidence_blob_missing', `evidence reference is missing: ${ref}`);
    }
    if (error.code === 'invalid_ref') {
      return new ReportIntegrityError('evidence_reference_invalid', `evidence reference is invalid: ${ref}`);
    }
    return new ReportIntegrityError('evidence_hash_mismatch', error.message);
  }
  return new ReportIntegrityError(
    'report_malformed',
    error instanceof Error ? error.message : String(error),
  );
}

export function createReportIntegrity(options: ReportIntegrityOptions): ReportIntegrity {
  const dereference = (ref: string): Uint8Array => {
    try {
      return options.evidence.get(ref);
    } catch (error) {
      throw mapStoreError(error, ref);
    }
  };

  const collectEvidence = (report: GateReport): GateReportEvidenceHash[] => {
    const collected: GateReportEvidenceHash[] = [];
    for (const check of report.checks) {
      if (typeof check.evidenceRef !== 'string' || check.evidenceRef.length === 0) {
        throw new ReportIntegrityError(
          'evidence_reference_missing',
          `gate check ${check.name} is missing evidenceRef`,
        );
      }
      const bytes = dereference(check.evidenceRef);
      collected.push({ evidenceRef: check.evidenceRef, sha256: sha256Hex(bytes) });
    }
    const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
    return collected.sort((left, right) =>
      compare(left.evidenceRef, right.evidenceRef) || compare(left.sha256, right.sha256),
    );
  };

  const verifyGateReport = (
    input: GateReport,
    identity: GateReportIdentity,
  ): AuthenticatedGateReport => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ReportIntegrityError('report_malformed', 'gate report must be an object');
    }
    const report = asAuthenticated(input);
    if (report.auth === undefined || typeof report.auth !== 'object') {
      throw new ReportIntegrityError('signature_missing', 'gate report signature metadata is missing');
    }
    if (
      report.auth.version !== 'gate-report-v1' ||
      report.auth.algorithm !== 'Ed25519' ||
      typeof report.auth.signatureBase64 !== 'string' ||
      report.auth.signatureBase64.length === 0
    ) {
      throw new ReportIntegrityError('signature_missing', 'gate report signature is missing or unsupported');
    }
    validateReportShape(report);
    if (report.runId !== identity.runId || report.taskId !== identity.taskId) {
      throw new ReportIntegrityError(
        'report_identity_mismatch',
        `gate report identity ${report.runId}/${report.taskId} does not match ${identity.runId}/${identity.taskId}`,
      );
    }
    if (report.auth.keyFingerprint !== options.authenticator.publicKeyFingerprintSha256) {
      throw new ReportIntegrityError(
        'public_key_fingerprint_mismatch',
        `report key fingerprint ${report.auth.keyFingerprint} does not match frozen run metadata`,
      );
    }
    const actualEvidence = collectEvidence(report);
    if (!Array.isArray(report.auth.evidence) || report.auth.evidence.length < actualEvidence.length) {
      throw new ReportIntegrityError('content_hash_missing', 'gate report is missing referenced content hashes');
    }
    if (report.auth.evidence.length !== actualEvidence.length) {
      throw new ReportIntegrityError('content_hash_mismatch', 'gate report contains an unexpected content-hash entry');
    }
    for (let index = 0; index < actualEvidence.length; index += 1) {
      const expected = report.auth.evidence[index];
      const actual = actualEvidence[index];
      if (
        expected?.evidenceRef !== actual?.evidenceRef ||
        expected?.sha256 !== actual?.sha256
      ) {
        throw new ReportIntegrityError(
          'content_hash_mismatch',
          `gate report evidence content hash mismatch at index ${index}`,
        );
      }
    }
    if (!options.authenticator.verify(signedBytes(report, report.auth.evidence), report.auth.signatureBase64)) {
      throw new ReportIntegrityError('signature_mismatch', 'gate report Ed25519 signature does not verify');
    }
    return report;
  };

  return {
    signGateReport(report, identity) {
      const authenticated = {
        ...report,
        runId: identity.runId,
        taskId: identity.taskId,
      } as AuthenticatedGateReport;
      const evidence = collectEvidence(authenticated);
      authenticated.auth = {
        version: 'gate-report-v1',
        algorithm: 'Ed25519',
        keyFingerprint: options.authenticator.publicKeyFingerprintSha256,
        evidence,
        signatureBase64: '',
      };
      authenticated.auth.signatureBase64 = options.authenticator.sign(
        signedBytes(authenticated, evidence),
      );
      return authenticated;
    },
    verifyGateReport,
    verifyGateReportRef(ref, identity) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(dereference(ref)));
      } catch (error) {
        if (error instanceof ReportIntegrityError) throw error;
        throw new ReportIntegrityError(
          'report_malformed',
          `gate report reference ${ref} is not valid JSON`,
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ReportIntegrityError('report_malformed', `gate report reference ${ref} is not an object`);
      }
      return verifyGateReport(parsed as GateReport, identity);
    },
    verifyEvidenceRef: dereference,
  };
}
