import type { PeriodSummary } from "@/components/reservation-period-card";
import { getPeriodWindowState } from "@/lib/period-window";
import type { StudentPeriodWeekPayload } from "@/lib/student-period-summary";
import { getStudyPeriodLabel } from "@/lib/study-periods";

export function toPeriodSummariesByDate(
  payload: StudentPeriodWeekPayload,
  now: Date = new Date()
): Readonly<Record<string, readonly PeriodSummary[]>> {
  return Object.fromEntries(
    payload.dates.map(({ date, periods }) => [
      date,
      periods.map((period) => ({
        capacity: period.capacity,
        closeTime: period.closeTime,
        confirmedCount: period.reservedCount,
        date,
        enabled: period.enabled,
        label: getStudyPeriodLabel(period.studyPeriod),
        myReservationId: period.myReservationId,
        openTime: period.openTime,
        remaining: period.availability,
        studyPeriod: period.studyPeriod,
        windowState: getPeriodWindowState(
          {
            closeTime: period.closeTime,
            date,
            openTime: period.openTime
          },
          now
        )
      }))
    ])
  );
}
