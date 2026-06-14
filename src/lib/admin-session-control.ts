export type AdminUserSessionRow = {
  readonly expiresAt: Date;
};

export type AdminUserSessionSummary = {
  readonly activeCount: number;
  readonly expiredCount: number;
  readonly totalCount: number;
};

export function summarizeUserSessions(
  sessions: readonly AdminUserSessionRow[],
  now: Date
): AdminUserSessionSummary {
  return sessions.reduce<AdminUserSessionSummary>(
    (summary, session) => {
      if (session.expiresAt.getTime() <= now.getTime()) {
        return {
          ...summary,
          expiredCount: summary.expiredCount + 1,
          totalCount: summary.totalCount + 1
        };
      }

      return {
        ...summary,
        activeCount: summary.activeCount + 1,
        totalCount: summary.totalCount + 1
      };
    },
    { activeCount: 0, expiredCount: 0, totalCount: 0 }
  );
}
