import { prisma } from "./db";
import { addDays } from "./date";
import { getPeriodWindowState, type PeriodWindowState } from "./period-window";
import {
  DEFAULT_PERIOD_CLOSE_TIME,
  DEFAULT_PERIOD_OPEN_TIME,
  GLOBAL_PERIOD_SETTINGS_DATE,
  buildDefaultPeriodSetting,
  periodSettingReadDates,
  resolveEffectivePeriodSetting,
  type PeriodSettingDefaults
} from "./period-setting-values";
import { STUDY_PERIODS, getStudyPeriodLabel, parseStudyPeriod, type StudyPeriod } from "./study-periods";

export type PeriodSummary = {
  readonly applicants: readonly PeriodApplicant[];
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly myReservationId: string | null;
  readonly openTime: string;
  readonly remaining: number;
  readonly studyPeriod: StudyPeriod;
  readonly windowState: PeriodWindowState;
};

export type PeriodWeekSummary = {
  readonly dates: readonly PeriodWeekDateSummary[];
};

export type PeriodWeekDateSummary = {
  readonly date: string;
  readonly periods: readonly PeriodWeekPeriodSummary[];
};

export type PeriodWeekPeriodSummary = {
  readonly studyPeriod: StudyPeriod;
  readonly openTime: string;
  readonly closeTime: string;
  readonly capacity: number;
  readonly reservedCount: number;
  readonly enabled: boolean;
  readonly availability: number;
  readonly myReservationId: string | null;
};

export type PeriodApplicant = {
  readonly name: string;
  readonly reservationId: string;
  readonly studentNumber: string;
};

type PeriodApplicantRow = PeriodApplicant & {
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
};

type PeriodReservationOwner = {
  readonly reservationId: string;
  readonly studyPeriod: StudyPeriod;
  readonly userId: string;
};

type PeriodReservationData = {
  readonly applicants: readonly PeriodApplicantRow[];
  readonly owners: readonly PeriodReservationOwner[];
};

type PeriodSummaryOptions = {
  readonly currentUserId?: string;
  readonly includeApplicants?: boolean;
  readonly now?: Date;
};

export {
  DEFAULT_PERIOD_CLOSE_TIME,
  DEFAULT_PERIOD_OPEN_TIME,
  GLOBAL_PERIOD_SETTINGS_DATE,
  buildDefaultPeriodSetting,
  periodSettingReadDates,
  resolveEffectivePeriodSetting,
  type PeriodSettingDefaults
} from "./period-setting-values";

export async function getPeriodSummaries(
  date: string,
  options: PeriodSummaryOptions = {}
): Promise<readonly PeriodSummary[]> {
  const now = options.now ?? new Date();
  const [settings, counts, reservationData] = await Promise.all([
    prisma.periodSetting.findMany({ where: { date: { in: [...periodSettingReadDates(date)] } } }),
    prisma.reservation.groupBy({
      by: ["studyPeriod"],
      where: { date, status: "CONFIRMED" },
      _count: { _all: true }
    }),
    getPeriodReservationData(date, options)
  ]);

  return STUDY_PERIODS.map((studyPeriod) => {
    const setting = resolveEffectivePeriodSetting(date, studyPeriod, settings);
    const count = counts.find((candidate) => candidate.studyPeriod === studyPeriod)?._count._all ?? 0;
    const periodApplicants = applicantsForPeriod(studyPeriod, reservationData.applicants);
    return {
      applicants: periodApplicants,
      capacity: setting.capacity,
      closeTime: setting.closeTime,
      confirmedCount: count,
      date,
      enabled: setting.enabled,
      label: getStudyPeriodLabel(studyPeriod),
      myReservationId: findMyReservationId(studyPeriod, reservationData.owners, options.currentUserId),
      openTime: setting.openTime,
      remaining: Math.max(setting.capacity - count, 0),
      studyPeriod,
      windowState: getPeriodWindowState(setting, now)
    };
  });
}

export async function getPeriodWeekSummaries(
  weekStart: string,
  options: { readonly currentUserId: string }
): Promise<PeriodWeekSummary> {
  const dates = Array.from({ length: 5 }, (_, index) => addDays(weekStart, index));
  const settingDates = [GLOBAL_PERIOD_SETTINGS_DATE, ...dates];
  const [settings, counts, reservations] = await Promise.all([
    prisma.periodSetting.findMany({ where: { date: { in: settingDates } } }),
    prisma.reservation.groupBy({
      _count: { _all: true },
      by: ["date", "studyPeriod"],
      where: { date: { in: dates }, status: "CONFIRMED" }
    }),
    prisma.reservation.findMany({
      orderBy: { createdAt: "asc" },
      select: { date: true, id: true, studyPeriod: true },
      where: { date: { in: dates }, status: "CONFIRMED", userId: options.currentUserId }
    })
  ]);

  return {
    dates: dates.map((date) => ({
      date,
      periods: STUDY_PERIODS.map((studyPeriod) => {
        const setting = resolveEffectivePeriodSetting(date, studyPeriod, settings);
        const reservedCount =
          counts.find(
            (count) => count.date === date && parseStudyPeriod(count.studyPeriod) === studyPeriod
          )?._count._all ?? 0;
        const myReservationId =
          reservations.find(
            (reservation) =>
              reservation.date === date && parseStudyPeriod(reservation.studyPeriod) === studyPeriod
          )?.id ?? null;
        return {
          studyPeriod,
          openTime: setting.openTime,
          closeTime: setting.closeTime,
          capacity: setting.capacity,
          reservedCount,
          enabled: setting.enabled,
          availability: Math.max(setting.capacity - reservedCount, 0),
          myReservationId
        };
      })
    }))
  };
}

async function getPeriodReservationData(
  date: string,
  options: PeriodSummaryOptions
): Promise<PeriodReservationData> {
  if (options.includeApplicants !== true) {
    if (!options.currentUserId) {
      return { applicants: [], owners: [] };
    }
    const reservations = await prisma.reservation.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, studyPeriod: true, userId: true },
      where: { date, status: "CONFIRMED", userId: options.currentUserId }
    });
    return {
      applicants: [],
      owners: reservations.map((reservation) => ({
        reservationId: reservation.id,
        studyPeriod: parseStudyPeriod(reservation.studyPeriod),
        userId: reservation.userId
      }))
    };
  }

  const reservations = await prisma.reservation.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      studyPeriod: true,
      userId: true,
      user: {
        select: {
          name: true,
          studentNumber: true
        }
      }
    },
    where: { date, status: "CONFIRMED" }
  });

  const applicants = reservations.map((reservation) => ({
    name: reservation.user.name,
    reservationId: reservation.id,
    studentNumber: reservation.user.studentNumber,
    studyPeriod: parseStudyPeriod(reservation.studyPeriod),
    userId: reservation.userId
  }));
  return { applicants, owners: applicants };
}

function applicantsForPeriod(
  studyPeriod: StudyPeriod,
  applicants: readonly PeriodApplicantRow[]
): readonly PeriodApplicant[] {
  return applicants
    .filter((applicant) => applicant.studyPeriod === studyPeriod)
    .map((applicant) => ({
      name: applicant.name,
      reservationId: applicant.reservationId,
      studentNumber: applicant.studentNumber
    }));
}

export function findMyReservationId(
  studyPeriod: StudyPeriod,
  applicants: readonly PeriodReservationOwner[],
  currentUserId: string | undefined
): string | null {
  if (!currentUserId) {
    return null;
  }
  return (
    applicants.find((applicant) => applicant.studyPeriod === studyPeriod && applicant.userId === currentUserId)
      ?.reservationId ?? null
  );
}

export async function ensurePeriodSettings(date: string): Promise<void> {
  const globalSettings = await prisma.periodSetting.findMany({
    where: { date: { in: [...periodSettingReadDates(date)] } }
  });

  for (const studyPeriod of STUDY_PERIODS) {
    const setting = resolveEffectivePeriodSetting(date, studyPeriod, globalSettings);
    await prisma.periodSetting.upsert({
      create: {
        capacity: setting.capacity,
        closeTime: setting.closeTime,
        date,
        enabled: setting.enabled,
        openTime: setting.openTime,
        studyPeriod
      },
      update: {},
      where: {
        date_studyPeriod: {
          date,
          studyPeriod
        }
      }
    });
  }
}

export function parseStoredStudyPeriod(value: string): StudyPeriod {
  return parseStudyPeriod(value);
}
