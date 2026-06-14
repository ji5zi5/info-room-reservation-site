import { type PeriodSummary } from "./period-settings";
import { getMockPeriodSummariesForUser } from "./mock-reservation-data";

export function getMockPeriodSummaries(
  date: string,
  input: {
    readonly currentUserId: string;
    readonly now?: Date;
  }
): readonly PeriodSummary[] {
  return getMockPeriodSummariesForUser(
    input.now ? { currentUserId: input.currentUserId, date, now: input.now } : { currentUserId: input.currentUserId, date }
  );
}
