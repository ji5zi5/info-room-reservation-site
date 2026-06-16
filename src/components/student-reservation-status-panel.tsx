"use client";

import type { ReactElement } from "react";

import {
  isStudentRestrictionActive,
  nextReservableAtLabel,
  studentReservationStatusLabel,
  type StudentCurrentReservation,
  type StudentStatusUser
} from "@/lib/student-reservation-status";

type StudentReservationStatusPanelProps = {
  readonly reservations: readonly StudentCurrentReservation[];
  readonly user: StudentStatusUser;
};

export function StudentReservationStatusPanel({
  reservations,
  user
}: StudentReservationStatusPanelProps): ReactElement {
  const restricted = isStudentRestrictionActive(user);
  const reservationSummary =
    reservations.length > 0 ? reservations.map(formatReservation).join(" / ") : "현재 예약 없음";
  const statusLabel = studentReservationStatusLabel(user);
  const summaryLabel = restricted ? "해제 시점" : "예약 가능 시점";

  return (
    <section aria-label="내 예약 상태" className="student-status-panel">
      <div className="student-status-head">
        <div>
          <h3>내 예약</h3>
          <p className="muted">{reservationSummary}</p>
        </div>
        <span className="student-status-chip" data-status={restricted ? "restricted" : "active"}>
          {statusLabel}
        </span>
      </div>
      <p className="student-status-summary">
        <span>{summaryLabel}</span>
        <strong>{nextReservableAtLabel(user)}</strong>
      </p>
    </section>
  );
}

function formatReservation(reservation: StudentCurrentReservation): string {
  return `${reservation.date} · ${reservation.label} · 확정`;
}
