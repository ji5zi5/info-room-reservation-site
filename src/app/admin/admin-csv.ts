import type { AdminAuditAction, AdminReservation, AdminStatistics } from "./admin-types";

const SPREADSHEET_FORMULA_PREFIX = /^[=+\-@\t\r\n＝＋－＠]/u;

export function buildReservationCsv(reservations: readonly AdminReservation[]): string {
  const rows = reservations.map((reservation) => [
    reservation.date,
    periodLabel(reservation.studyPeriod),
    reservation.status,
    reservation.user.name,
    reservation.user.studentNumber,
    reservation.reason ?? ""
  ]);
  return [["날짜", "시간대", "상태", "이름", "학번", "사유"], ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}

export function buildStatisticsCsv(statistics: AdminStatistics): string {
  return [
    ["구분", "날짜", "시간대", "전체", "확정", "취소", "노쇼", "고유학생", "정원", "채움률", "이름", "학번"],
    [
      "전체",
      `${statistics.from} - ${statistics.to}`,
      "",
      numberCell(statistics.totals.totalCount),
      numberCell(statistics.totals.confirmedCount),
      numberCell(statistics.totals.cancelledCount),
      numberCell(statistics.totals.noShowCount),
      numberCell(statistics.totals.uniqueStudentCount),
      "",
      "",
      "",
      ""
    ],
    ...statistics.periodStats.map((period) => [
      "시간대",
      "",
      period.label,
      numberCell(period.totalCount),
      numberCell(period.confirmedCount),
      numberCell(period.cancelledCount),
      numberCell(period.noShowCount),
      "",
      numberCell(period.capacity),
      numberCell(period.fillRate),
      "",
      ""
    ]),
    ...statistics.dailyStats.map((daily) => [
      "일자",
      daily.date,
      "",
      numberCell(daily.totalCount),
      numberCell(daily.confirmedCount),
      numberCell(daily.cancelledCount),
      numberCell(daily.noShowCount),
      "",
      "",
      "",
      "",
      ""
    ]),
    ...statistics.repeatedOffenders.map((offender) => [
      "반복자",
      "",
      "",
      numberCell(offender.totalIncidents),
      "",
      numberCell(offender.cancelledCount),
      numberCell(offender.noShowCount),
      "",
      "",
      "",
      offender.name,
      offender.studentNumber
    ])
  ]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}

export function buildAuditActionsCsv(actions: readonly AdminAuditAction[]): string {
  const rows = actions.map((action) => [
    action.createdAt,
    action.category,
    action.action,
    action.actor?.name ?? "",
    action.actor?.studentNumber ?? "",
    action.targetUser?.name ?? "",
    action.targetUser?.studentNumber ?? "",
    action.reason ?? "",
    action.reservationId ?? ""
  ]);
  return [["시각", "분류", "액션", "처리자", "처리자학번", "대상", "대상학번", "사유", "예약ID"], ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}

function periodLabel(studyPeriod: string): string {
  switch (studyPeriod) {
    case "EIGHTH":
      return "8면학";
    case "FIRST":
      return "1면학";
    default:
      return studyPeriod;
  }
}

function escapeCsvCell(value: string): string {
  const formulaPrefix = SPREADSHEET_FORMULA_PREFIX.test(value);
  if (!formulaPrefix && !/[",\t\r\n]/u.test(value)) {
    return value;
  }
  const safeValue = formulaPrefix ? `'${value}` : value;
  return `"${safeValue.replace(/"/gu, '""')}"`;
}

function numberCell(value: number): string {
  return value.toString();
}
