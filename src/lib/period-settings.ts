import { prisma } from "./db";
import { DEFAULT_PERIOD_CAPACITY, STUDY_PERIODS, getStudyPeriodLabel, parseStudyPeriod, type StudyPeriod } from "./study-periods";

export type PeriodSummary = {
  readonly applicants: readonly PeriodApplicant[];
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly openTime: string;
  readonly remaining: number;
  readonly studyPeriod: StudyPeriod;
};

export type PeriodApplicant = {
  readonly name: string;
  readonly reservationId: string;
  readonly studentNumber: string;
};

type PeriodApplicantRow = PeriodApplicant & {
  readonly studyPeriod: StudyPeriod;
};

type PeriodSummaryOptions = {
  readonly includeApplicants?: boolean;
};

export async function getPeriodSummaries(
  date: string,
  options: PeriodSummaryOptions = {}
): Promise<readonly PeriodSummary[]> {
  await ensurePeriodSettings(date);
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
    const setting = settings.find((candidate) => candidate.studyPeriod === studyPeriod);
    if (!setting) {
      throw new MissingPeriodSettingError(date, studyPeriod);
    }
    const count = counts.find((candidate) => candidate.studyPeriod === studyPeriod)?._count._all ?? 0;
    return {
      applicants: applicantsForPeriod(studyPeriod, applicants),
      capacity: setting.capacity,
      closeTime: setting.closeTime,
      confirmedCount: count,
      date,
      enabled: setting.enabled,
      label: getStudyPeriodLabel(studyPeriod),
      openTime: setting.openTime,
      remaining: Math.max(setting.capacity - count, 0),
      studyPeriod
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
    studyPeriod: parseStudyPeriod(reservation.studyPeriod)
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

export async function ensurePeriodSettings(date: string): Promise<void> {
  for (const studyPeriod of STUDY_PERIODS) {
    await prisma.periodSetting.upsert({
      create: {
        capacity: DEFAULT_PERIOD_CAPACITY,
        closeTime: "23:00",
        date,
        enabled: true,
        openTime: "08:00",
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

class MissingPeriodSettingError extends Error {
  public constructor(date: string, studyPeriod: StudyPeriod) {
    super(`Missing period setting for ${date} ${studyPeriod}`);
    this.name = "MissingPeriodSettingError";
  }
}
