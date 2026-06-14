export type MaintenanceCleanupResult = {
  readonly csrfTokensDeleted: number;
  readonly rateLimitBucketsDeleted: number;
  readonly restrictionsReleased: number;
  readonly sessionsDeleted: number;
};

export type MaintenanceCleanupStore = {
  readonly deleteExpiredCsrfTokens: (now: Date) => Promise<number>;
  readonly deleteExpiredRateLimitBuckets: (now: Date) => Promise<number>;
  readonly deleteExpiredSessions: (now: Date) => Promise<number>;
  readonly releaseExpiredRestrictions: (now: Date) => Promise<number>;
};

export async function runMaintenanceCleanup(input: {
  readonly now: Date;
  readonly store: MaintenanceCleanupStore;
}): Promise<MaintenanceCleanupResult> {
  const sessionsDeleted = await input.store.deleteExpiredSessions(input.now);
  const csrfTokensDeleted = await input.store.deleteExpiredCsrfTokens(input.now);
  const rateLimitBucketsDeleted = await input.store.deleteExpiredRateLimitBuckets(input.now);
  const restrictionsReleased = await input.store.releaseExpiredRestrictions(input.now);

  return {
    csrfTokensDeleted,
    rateLimitBucketsDeleted,
    restrictionsReleased,
    sessionsDeleted
  };
}
