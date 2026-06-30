import { getStudyPeriodLabel, parseStudyPeriod } from "./study-periods";

export const STUDENT_NOTIFICATION_ACTIONS = ["ADMIN_RESERVATION_CANCEL"] as const;

export type StudentNotificationAction = (typeof STUDENT_NOTIFICATION_ACTIONS)[number];

export type StudentNotification = {
  readonly createdAt: string;
  readonly id: string;
  readonly message: string;
  readonly title: string;
};

export type StudentNotificationActionRow = {
  readonly action: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly reservation: {
    readonly date: string;
    readonly studyPeriod: string;
  } | null;
};

const STUDENT_NOTIFICATION_ACTION_SET = new Set<string>(STUDENT_NOTIFICATION_ACTIONS);

export function buildStudentNotifications(rows: readonly StudentNotificationActionRow[]): readonly StudentNotification[] {
  return rows.flatMap((row) => {
    const notification = buildStudentNotification(row);
    return notification ? [notification] : [];
  });
}

function buildStudentNotification(row: StudentNotificationActionRow): StudentNotification | null {
  if (!isStudentNotificationAction(row.action)) {
    return null;
  }

  switch (row.action) {
    case "ADMIN_RESERVATION_CANCEL":
      return {
        createdAt: row.createdAt.toISOString(),
        id: row.id,
        message: `${reservationName(row.reservation)} 신청이 취소되었습니다.`,
        title: "관리자 취소 안내"
      };
    default:
      return assertNever(row.action);
  }
}

function isStudentNotificationAction(value: string): value is StudentNotificationAction {
  return STUDENT_NOTIFICATION_ACTION_SET.has(value);
}

function reservationName(reservation: StudentNotificationActionRow["reservation"]): string {
  if (reservation === null) {
    return "예약";
  }
  const studyPeriod = parseStudyPeriod(reservation.studyPeriod);
  return `${reservation.date} ${getStudyPeriodLabel(studyPeriod)}`;
}

function assertNever(value: never): never {
  throw new UnreachableStudentNotificationActionError(String(value));
}

class UnreachableStudentNotificationActionError extends Error {
  public constructor(value: string) {
    super(`Unhandled student notification action: ${value}`);
    this.name = "UnreachableStudentNotificationActionError";
  }
}
