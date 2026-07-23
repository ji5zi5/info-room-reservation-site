import { describe, expect, it } from "vitest";

import {
  buildRetentionPreview,
  DEFAULT_RETENTION_POLICY,
  missingRetentionApprovalFields,
  normalizeRetentionPolicy,
  RETENTION_BATCH_SIZE,
  type RetentionPolicy
} from "./retention-policy";

describe("retention policy", () => {
  it("defaults every destructive horizon to null and cleanup to disabled", () => {
    expect(normalizeRetentionPolicy(null)).toEqual(DEFAULT_RETENTION_POLICY);
    expect(DEFAULT_RETENTION_POLICY).toMatchObject({
      adminDetailDays: null,
      auditDetailDays: null,
      departedUserIdentityDays: null,
      enabled: false,
      reservationReasonDays: null,
      sanctionReasonDays: null
    });
    expect(RETENTION_BATCH_SIZE).toBe(100);
  });

  it("requires complete horizons and approval metadata", () => {
    expect(missingRetentionApprovalFields(approvedPolicy())).toEqual([]);
    expect(
      missingRetentionApprovalFields({
        ...approvedPolicy(),
        approvedAt: null,
        reservationReasonDays: null
      })
    ).toEqual(["approvedAt", "reservationReasonDays"]);
  });

  it("builds deterministic counts and a version-bound checksum from sorted candidate IDs", () => {
    const candidates = {
      adminActionDetails: ["action-b", "action-a"],
      auditDetails: ["audit-a"],
      departedUserIdentities: ["user-b", "user-a"],
      reservationReasons: ["reservation-a"],
      sanctionReasons: []
    };

    const preview = buildRetentionPreview(approvedPolicy(), candidates);
    const reordered = buildRetentionPreview(approvedPolicy(), {
      ...candidates,
      adminActionDetails: [...candidates.adminActionDetails].reverse(),
      departedUserIdentities: [...candidates.departedUserIdentities].reverse()
    });
    const nextVersion = buildRetentionPreview(
      { ...approvedPolicy(), policyVersion: "school-policy-v2" },
      candidates
    );

    expect(preview.counts).toEqual({
      adminActionDetails: 2,
      auditDetails: 1,
      departedUserIdentities: 2,
      reservationReasons: 1,
      sanctionReasons: 0
    });
    expect(preview.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(reordered.checksum).toBe(preview.checksum);
    expect(nextVersion.checksum).not.toBe(preview.checksum);
  });
});

function approvedPolicy(): RetentionPolicy {
  return {
    adminDetailDays: 365,
    approvedAt: new Date("2026-07-01T00:00:00.000Z"),
    approvedBy: "school-privacy-officer",
    auditDetailDays: 365,
    departedUserIdentityDays: 30,
    enabled: false,
    id: "global",
    policyVersion: "school-policy-v1",
    reservationReasonDays: 90,
    sanctionReasonDays: 365
  };
}
