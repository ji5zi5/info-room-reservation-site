import { getStudyPeriodLabel, parseStudyPeriod } from "./study-periods";

export const STUDENT_NOTIFICATION_ACTIONS = ["ADMIN_RESERVATION_CANCEL"] as const;

export type StudentNotificationAction = (typeof STUDENT_NOTIFICATION_ACTIONS)[number];

export type StudentNotification = {
  readonly createdAt: string;
  readonly id: string;
  readonly message: string;
  readonly reason: string | null;
  readonly title: string;
};

export type StudentNotificationActionRow = {
  readonly action: string;
  readonly createdAt: Date;
  readonly id: string;
  readonly reason: string | null;
  readonly reservation: {
    readonly date: string;
    readonly studyPeriod: string;
  } | null;
};

export type StudentNotificationPresentationInput =
  | { readonly kind: "loaded"; readonly notifications: readonly StudentNotification[] }
  | { readonly kind: "loading" }
  | { readonly kind: "stale"; readonly notifications: readonly StudentNotification[] };

export type StudentNotificationPresentation =
  | { readonly count: 0; readonly kind: "empty"; readonly notifications: readonly [] }
  | { readonly count: 0; readonly kind: "loading"; readonly notifications: readonly [] }
  | {
      readonly count: number;
      readonly kind: "ready";
      readonly notifications: readonly StudentNotification[];
    }
  | {
      readonly count: number;
      readonly kind: "stale";
      readonly notifications: readonly StudentNotification[];
    };

const STUDENT_NOTIFICATION_ACTION_SET = new Set<string>(STUDENT_NOTIFICATION_ACTIONS);
const STUDENT_NOTIFICATION_LIMIT = 5;

export function buildStudentNotifications(rows: readonly StudentNotificationActionRow[]): readonly StudentNotification[] {
  return boundedRecentNotifications(
    rows.flatMap((row) => {
      const notification = buildStudentNotification(row);
      return notification ? [notification] : [];
    })
  );
}

export function buildStudentNotificationPresentation(
  input: StudentNotificationPresentationInput
): StudentNotificationPresentation {
  switch (input.kind) {
    case "loading":
      return { count: 0, kind: "loading", notifications: [] };
    case "loaded": {
      const notifications = boundedRecentNotifications(input.notifications);
      return notifications.length === 0
        ? { count: 0, kind: "empty", notifications: [] }
        : { count: notifications.length, kind: "ready", notifications };
    }
    case "stale": {
      const notifications = boundedRecentNotifications(input.notifications);
      return { count: notifications.length, kind: "stale", notifications };
    }
    default:
      return assertNeverPresentationInput(input);
  }
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
        reason: notificationReason(row.reason),
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

function notificationReason(reason: string | null): string | null {
  const normalized = reason?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function boundedRecentNotifications(
  notifications: readonly StudentNotification[]
): readonly StudentNotification[] {
  return [...notifications]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, STUDENT_NOTIFICATION_LIMIT);
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

function assertNeverPresentationInput(value: never): never {
  throw new UnreachableStudentNotificationPresentationError(String(value));
}

class UnreachableStudentNotificationPresentationError extends Error {
  public constructor(value: string) {
    super(`Unhandled student notification presentation input: ${value}`);
    this.name = "UnreachableStudentNotificationPresentationError";
  }
}
