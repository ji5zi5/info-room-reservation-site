import { DEFAULT_PERIOD_CAPACITY, type StudyPeriod } from "./study-periods";

export const DEFAULT_PERIOD_OPEN_TIME = "13:00";
export const DEFAULT_PERIOD_CLOSE_TIME = "16:20";
export const GLOBAL_PERIOD_SETTINGS_DATE = "__global__";

export type PeriodSettingSnapshot = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: string;
};

export type PeriodSettingDefaults = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

export function periodSettingReadDates(date: string): readonly string[] {
  return date === GLOBAL_PERIOD_SETTINGS_DATE ? [GLOBAL_PERIOD_SETTINGS_DATE] : [date, GLOBAL_PERIOD_SETTINGS_DATE];
}

export function resolveEffectivePeriodSetting(
  date: string,
  studyPeriod: StudyPeriod,
  settings: readonly PeriodSettingSnapshot[]
): PeriodSettingDefaults {
  const setting =
    settings.find((candidate) => candidate.date === date && candidate.studyPeriod === studyPeriod) ??
    settings.find((candidate) => candidate.date === GLOBAL_PERIOD_SETTINGS_DATE && candidate.studyPeriod === studyPeriod);

  if (!setting) {
    return buildDefaultPeriodSetting(date, studyPeriod);
  }

  return {
    capacity: setting.capacity,
    closeTime: setting.closeTime,
    date,
    enabled: setting.enabled,
    openTime: setting.openTime,
    studyPeriod
  };
}

export function buildDefaultPeriodSetting(date: string, studyPeriod: StudyPeriod): PeriodSettingDefaults {
  return {
    capacity: DEFAULT_PERIOD_CAPACITY,
    closeTime: DEFAULT_PERIOD_CLOSE_TIME,
    date,
    enabled: true,
    openTime: DEFAULT_PERIOD_OPEN_TIME,
    studyPeriod
  };
}
