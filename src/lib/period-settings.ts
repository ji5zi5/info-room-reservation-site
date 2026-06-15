import { prisma } from "./db";
import { getPeriodWindowState, type PeriodWindowState } from "./period-window";
import { DEFAULT_PERIOD_CAPACITY, STUDY_PERIODS, getStudyPeriodLabel, parseStudyPeriod, type StudyPeriod } from "./study-periods";

export const DEFAULT_PERIOD_OPEN_TIME = "13:00";
export const DEFAULT_PERIOD_CLOSE_TIME = "16:20";

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

type PeriodSummaryOptions = {
  readonly currentUserId?: string;
  readonly includeApplicants?: boolean;
  readonly now?: Date;
};

export type PeriodSettingDefaults = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};

export async function getPeriodSummaries(
  date: string,
  options: PeriodSummaryOptions = {}
): Promise<readonly PeriodSummary[]> {
  const now = options.now ?? new Date();
  const [settings, counts, applicants] = await Promise.all([
    prisma.periodSetting.findMany({ where: { date } }),
    prisma.reservation.groupBy({
      by: ["studyPeriod"],
      where: { date, status: "CONFIRMED" },
      _count: { _all: true }
    }),
    getPeriodApplicants(date, options.includeApplicants === true)
  ]);

  return STUDY_PERIODS.map((studyPeriod) => {
    const setting = settings.find((candidate) => candidate.studyPeriod === studyPeriod) ?? buildDefaultPeriodSetting(date, studyPeriod);
    const count = counts.find((candidate) => candidate.studyPeriod === studyPeriod)?._count._all ?? 0;
    const periodApplicants = applicantsForPeriod(studyPeriod, applicants);
    return {
      applicants: periodApplicants,
      capacity: setting.capacity,
      closeTime: setting.closeTime,
      confirmedCount: count,
      date,
      enabled: setting.enabled,
      label: getStudyPeriodLabel(studyPeriod),
      myReservationId: findMyReservationId(studyPeriod, applicants, options.currentUserId),
      openTime: setting.openTime,
      remaining: Math.max(setting.capacity - count, 0),
      studyPeriod,
      windowState: getPeriodWindowState(setting, now)
    };
  });
}

async function getPeriodApplicants(date: string, includeApplicants: boolean): Promise<readonly PeriodApplicantRow[]> {
  if (!includeApplicants) {
    return [];
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

  return reservations.map((reservation) => ({
    name: reservation.user.name,
    reservationId: reservation.id,
    studentNumber: reservation.user.studentNumber,
    studyPeriod: parseStudyPeriod(reservation.studyPeriod),
    userId: reservation.userId
  }));
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
  for (const studyPeriod of STUDY_PERIODS) {
    await prisma.periodSetting.upsert({
      create: {
        capacity: DEFAULT_PERIOD_CAPACITY,
        closeTime: DEFAULT_PERIOD_CLOSE_TIME,
        date,
        enabled: true,
        openTime: DEFAULT_PERIOD_OPEN_TIME,
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
