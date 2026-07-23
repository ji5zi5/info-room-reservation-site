import { createHash } from "node:crypto";

export const GLOBAL_RETENTION_POLICY_ID = "global";
export const RETENTION_BATCH_SIZE = 100;
export const RETENTION_EXPIRED_TEXT = "[보존 기간 만료]";

export type RetentionPolicy = {
  readonly adminDetailDays: number | null;
  readonly approvedAt: Date | null;
  readonly approvedBy: string | null;
  readonly auditDetailDays: number | null;
  readonly departedUserIdentityDays: number | null;
  readonly enabled: boolean;
  readonly id: string;
  readonly policyVersion: string;
  readonly reservationReasonDays: number | null;
  readonly sanctionReasonDays: number | null;
};

export type RetentionPolicyDraft = Omit<RetentionPolicy, "enabled" | "id">;

export type RetentionCandidateIds = {
  readonly adminActionDetails: readonly string[];
  readonly auditDetails: readonly string[];
  readonly departedUserIdentities: readonly string[];
  readonly reservationReasons: readonly string[];
  readonly sanctionReasons: readonly string[];
};

export type RetentionCounts = {
  readonly adminActionDetails: number;
  readonly auditDetails: number;
  readonly departedUserIdentities: number;
  readonly reservationReasons: number;
  readonly sanctionReasons: number;
};

export type RetentionPreview = {
  readonly checksum: string;
  readonly counts: RetentionCounts;
  readonly policyVersion: string;
};

export type RetentionCleanupResult = {
  readonly counts: RetentionCounts;
  readonly kind: "applied" | "disabled" | "unapproved";
  readonly policyVersion: string;
};

export const EMPTY_RETENTION_COUNTS: RetentionCounts = {
  adminActionDetails: 0,
  auditDetails: 0,
  departedUserIdentities: 0,
  reservationReasons: 0,
  sanctionReasons: 0
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  adminDetailDays: null,
  approvedAt: null,
  approvedBy: null,
  auditDetailDays: null,
  departedUserIdentityDays: null,
  enabled: false,
  id: GLOBAL_RETENTION_POLICY_ID,
  policyVersion: "unapproved",
  reservationReasonDays: null,
  sanctionReasonDays: null
};

export function normalizeRetentionPolicy(policy: RetentionPolicy | null): RetentionPolicy {
  return policy ?? DEFAULT_RETENTION_POLICY;
}

export function missingRetentionApprovalFields(policy: RetentionPolicy): readonly string[] {
  const missing: string[] = [];
  if (!policy.approvedAt) {
    missing.push("approvedAt");
  }
  if (!policy.approvedBy?.trim()) {
    missing.push("approvedBy");
  }
  if (!policy.policyVersion.trim() || policy.policyVersion === "unapproved") {
    missing.push("policyVersion");
  }
  for (const [field, value] of retentionHorizons(policy)) {
    if (value === null || value <= 0) {
      missing.push(field);
    }
  }
  return missing;
}

export function buildRetentionPreview(
  policy: RetentionPolicy,
  candidates: RetentionCandidateIds
): RetentionPreview {
  const sortedCandidates = {
    adminActionDetails: sortedUnique(candidates.adminActionDetails),
    auditDetails: sortedUnique(candidates.auditDetails),
    departedUserIdentities: sortedUnique(candidates.departedUserIdentities),
    reservationReasons: sortedUnique(candidates.reservationReasons),
    sanctionReasons: sortedUnique(candidates.sanctionReasons)
  };
  return {
    checksum: createHash("sha256")
      .update(JSON.stringify({ candidates: sortedCandidates, policyVersion: policy.policyVersion }))
      .digest("hex"),
    counts: {
      adminActionDetails: sortedCandidates.adminActionDetails.length,
      auditDetails: sortedCandidates.auditDetails.length,
      departedUserIdentities: sortedCandidates.departedUserIdentities.length,
      reservationReasons: sortedCandidates.reservationReasons.length,
      sanctionReasons: sortedCandidates.sanctionReasons.length
    },
    policyVersion: policy.policyVersion
  };
}

export function retentionCutoff(now: Date, days: number | null): Date | null {
  return days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

function retentionHorizons(policy: RetentionPolicy): readonly (readonly [string, number | null])[] {
  return [
    ["adminDetailDays", policy.adminDetailDays],
    ["auditDetailDays", policy.auditDetailDays],
    ["departedUserIdentityDays", policy.departedUserIdentityDays],
    ["reservationReasonDays", policy.reservationReasonDays],
    ["sanctionReasonDays", policy.sanctionReasonDays]
  ];
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
