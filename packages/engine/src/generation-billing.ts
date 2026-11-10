import type { GenerationFeeSettlement, GenerationFeeTerms } from '@media-router/contracts';
import type { AdmissionFeeSnapshot, CostIdentity, ProviderCostEvidence } from './billing-fees.js';

export interface GenerationFeeAdmission {
  schemaVersion: 1;
  snapshot: AdmissionFeeSnapshot;
  customerCeilingMicros: number;
}

export interface GenerationCostScope extends CostIdentity {
  workspaceId: string;
  jobId: string;
  routeId: string;
  credentialIdentity: string;
}

export interface GenerationCostEvidence {
  workspaceId: string;
  jobId: string;
  routeId: string;
  credentialIdentity: string | null;
  evidence: ProviderCostEvidence;
}

export function generationFeeTerms(snapshot: AdmissionFeeSnapshot): GenerationFeeTerms {
  if (snapshot.service === 'legacy') throw new Error('Invalid generation fee snapshot.');
  return {
    policyId: snapshot.policy.id,
    policyVersion: snapshot.policy.version,
    service: snapshot.service,
    basisPoints: snapshot.appliedBasisPoints,
  };
}

/** Explicit projection keeps supplier evidence and credential identities private. */
export function generationFeeSettlementView(
  value: GenerationFeeSettlement,
): GenerationFeeSettlement {
  return {
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    service: value.service,
    basisPoints: value.basisPoints,
    costStatus: value.costStatus,
    providerCostMicros: value.providerCostMicros,
    customerProviderDebitMicros: value.customerProviderDebitMicros,
    nominalFeeMicros: value.nominalFeeMicros,
    collectedFeeMicros: value.collectedFeeMicros,
    waivedFeeMicros: value.waivedFeeMicros,
    operatorOverrunMicros: value.operatorOverrunMicros,
    customerTotalMicros: value.customerTotalMicros,
  };
}
