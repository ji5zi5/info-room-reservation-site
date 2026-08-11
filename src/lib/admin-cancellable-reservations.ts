import { toKstDate } from "./date";
import { resolveEffectivePeriodSetting, type PeriodSettingSnapshot } from "./period-setting-values";
import { isPeriodWindowClosed } from "./period-window";
import { parseStudyPeriod } from "./study-periods";

export type AdminCancellationCandidate = {
  readonly date: string;
  readonly id: string;
  readonly status: string;
  readonly studyPeriod: string;
};

export function selectCancellableConfirmedReservationIds(input: {
  readonly now: Date;
  readonly reservations: readonly AdminCancellationCandidate[];
  readonly settings: readonly PeriodSettingSnapshot[];
}): readonly string[] {
  const today = toKstDate(input.now);
  return input.reservations
    .filter((reservation) => {
      if (reservation.status !== "CONFIRMED" || reservation.date < today) {
        return false;
      }
      if (reservation.date > today) {
        return true;
      }
      const setting = resolveEffectivePeriodSetting(today, parseStudyPeriod(reservation.studyPeriod), input.settings);
      return !isPeriodWindowClosed(setting, input.now);
    })
    .map((reservation) => reservation.id);
}
