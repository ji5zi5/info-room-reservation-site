export type UserSanctionRow = {
  readonly createdAt: Date;
  readonly endsAt: Date | null;
  readonly id: string;
  readonly reason: string;
  readonly revokedAt: Date | null;
  readonly status: string;
  readonly type: string;
};

export type UserSanctionSummary = {
  readonly activeCount: number;
  readonly permanentCount: number;
  readonly revokedCount: number;
  readonly totalCount: number;
};

export function orderUserSanctions<T extends UserSanctionRow>(sanctions: readonly T[]): readonly T[] {
  return [...sanctions].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

export function summarizeUserSanctions(sanctions: readonly UserSanctionRow[]): UserSanctionSummary {
  return sanctions.reduce<UserSanctionSummary>(
    (summary, sanction) => ({
      activeCount: summary.activeCount + (sanction.status === "ACTIVE" ? 1 : 0),
      permanentCount: summary.permanentCount + (sanction.status === "ACTIVE" && sanction.endsAt === null ? 1 : 0),
      revokedCount: summary.revokedCount + (sanction.status === "REVOKED" || sanction.revokedAt !== null ? 1 : 0),
      totalCount: summary.totalCount + 1
    }),
    { activeCount: 0, permanentCount: 0, revokedCount: 0, totalCount: 0 }
  );
}
