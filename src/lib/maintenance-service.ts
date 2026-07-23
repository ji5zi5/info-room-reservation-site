import type { RetentionCleanupResult } from "./retention-policy";

export type MaintenanceCleanupResult = {
  readonly csrfTokensDeleted: number;
  readonly expiredSanctionsRevoked: number;
  readonly rateLimitBucketsDeleted: number;
  readonly retention: RetentionCleanupResult;
  readonly restrictionsReleased: number;
  readonly sessionsDeleted: number;
};

export type MaintenanceCleanupStore = {
  readonly applyRetentionPolicy: (now: Date) => Promise<RetentionCleanupResult>;
  readonly deleteExpiredCsrfTokens: (now: Date) => Promise<number>;
  readonly deleteExpiredRateLimitBuckets: (now: Date) => Promise<number>;
  readonly deleteExpiredSessions: (now: Date) => Promise<number>;
  readonly releaseExpiredRestrictions: (now: Date) => Promise<number>;
  readonly revokeExpiredSanctions: (now: Date) => Promise<number>;
};

export async function runMaintenanceCleanup(input: {
  readonly now: Date;
  readonly store: MaintenanceCleanupStore;
}): Promise<MaintenanceCleanupResult> {
  const sessionsDeleted = await input.store.deleteExpiredSessions(input.now);
  const csrfTokensDeleted = await input.store.deleteExpiredCsrfTokens(input.now);
  const rateLimitBucketsDeleted = await input.store.deleteExpiredRateLimitBuckets(input.now);
  const restrictionsReleased = await input.store.releaseExpiredRestrictions(input.now);
  const expiredSanctionsRevoked = await input.store.revokeExpiredSanctions(input.now);
  const retention = await input.store.applyRetentionPolicy(input.now);

  return {
    csrfTokensDeleted,
    expiredSanctionsRevoked,
    rateLimitBucketsDeleted,
    retention,
    restrictionsReleased,
    sessionsDeleted
  };
}
