import type { AdminReservation } from "./admin-types";

export function buildReservationCsv(reservations: readonly AdminReservation[]): string {
  const rows = reservations.map((reservation) => [
    reservation.date,
    periodLabel(reservation.studyPeriod),
    reservation.status,
    reservation.user.name,
    reservation.user.studentNumber
  ]);
  return [["날짜", "시간대", "상태", "이름", "학번"], ...rows]
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
  if (!/[",\n]/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/gu, '""')}"`;
}
