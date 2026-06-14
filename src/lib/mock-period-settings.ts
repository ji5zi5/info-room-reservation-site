import {
  DEFAULT_PERIOD_CLOSE_TIME,
  DEFAULT_PERIOD_OPEN_TIME,
  type PeriodSummary
} from "./period-settings";
import { getPeriodWindowState } from "./period-window";
import { DEFAULT_PERIOD_CAPACITY, STUDY_PERIODS, getStudyPeriodLabel, type StudyPeriod } from "./study-periods";

export type MockAdminPeriodSettingInput = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

const mockSettingsByDate = getGlobalMockPeriodSettingsStore();

export function getMockAdminPeriodSettings(date: string, now = new Date()): readonly PeriodSummary[] {
  const settings = getStoredSettings(date);
  return STUDY_PERIODS.map((studyPeriod) => {
    const setting = settings.find((candidate) => candidate.studyPeriod === studyPeriod);
    if (!setting) {
      throw new MissingMockPeriodSettingError(date, studyPeriod);
    }
    return {
      applicants: [],
      capacity: setting.capacity,
      closeTime: setting.closeTime,
      confirmedCount: 0,
      date,
      enabled: setting.enabled,
      label: getStudyPeriodLabel(studyPeriod),
      myReservationId: null,
      openTime: setting.openTime,
      remaining: setting.capacity,
      studyPeriod,
      windowState: getPeriodWindowState({ closeTime: setting.closeTime, date, openTime: setting.openTime }, now)
    };
  });
}

export function updateMockAdminPeriodSettings(
  date: string,
  periods: readonly MockAdminPeriodSettingInput[],
  now = new Date()
): readonly PeriodSummary[] {
  const incomingByPeriod = new Map(periods.map((period) => [period.studyPeriod, period]));
  const nextSettings = STUDY_PERIODS.map((studyPeriod) => {
    const incoming = incomingByPeriod.get(studyPeriod);
    return incoming ?? defaultSetting(studyPeriod);
  });
  mockSettingsByDate.set(date, nextSettings);
  return getMockAdminPeriodSettings(date, now);
}

export function resetMockAdminPeriodSettingsForTests(): void {
  mockSettingsByDate.clear();
}

function getStoredSettings(date: string): readonly MockAdminPeriodSettingInput[] {
  const stored = mockSettingsByDate.get(date);
  if (stored) {
    return stored;
  }
  const defaults = STUDY_PERIODS.map(defaultSetting);
  mockSettingsByDate.set(date, defaults);
  return defaults;
}

function defaultSetting(studyPeriod: StudyPeriod): MockAdminPeriodSettingInput {
  return {
    capacity: DEFAULT_PERIOD_CAPACITY,
    closeTime: DEFAULT_PERIOD_CLOSE_TIME,
    enabled: true,
    openTime: DEFAULT_PERIOD_OPEN_TIME,
    studyPeriod
  };
}

class MissingMockPeriodSettingError extends Error {
  public constructor(date: string, studyPeriod: StudyPeriod) {
    super(`Missing mock period setting for ${date} ${studyPeriod}`);
    this.name = "MissingMockPeriodSettingError";
  }
}

function getGlobalMockPeriodSettingsStore(): Map<string, readonly MockAdminPeriodSettingInput[]> {
  const globalStore = globalThis as typeof globalThis & {
    __infoRoomMockPeriodSettings?: Map<string, readonly MockAdminPeriodSettingInput[]>;
  };
  globalStore.__infoRoomMockPeriodSettings ??= new Map<string, readonly MockAdminPeriodSettingInput[]>();
  return globalStore.__infoRoomMockPeriodSettings;
}
