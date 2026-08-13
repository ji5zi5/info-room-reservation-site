"use client";

import { CalendarCheck } from "lucide-react";
import type { ReactElement } from "react";

import {
  isStudentRestrictionActive,
  nextReservableAtLabel,
  studentReservationStatusLabel,
  type StudentCurrentReservation,
  type StudentStatusUser
} from "@/lib/student-reservation-status";

type StudentReservationStatusPanelProps = {
  readonly ariaLabel?: string;
  readonly currentReservationId?: string | null;
  readonly onSelectReservation?: ((reservation: StudentCurrentReservation) => void) | undefined;
  readonly reservations: readonly StudentCurrentReservation[];
  readonly user: StudentStatusUser;
};

export function StudentReservationStatusPanel({
  ariaLabel = "내 예약 상태",
  currentReservationId = null,
  onSelectReservation,
  reservations,
  user
}: StudentReservationStatusPanelProps): ReactElement | null {
  if (!onSelectReservation) {
    return null;
  }

  const restricted = isStudentRestrictionActive(user);
  const reservationSummary = reservations.length > 0 ? `${reservations.length}건 확정` : "현재 예약 없음";
  const statusLabel = studentReservationStatusLabel(user);
  const summaryLabel = restricted ? "해제 시점" : "예약 가능 시점";

  return (
    <section aria-label={ariaLabel} className="student-status-panel">
      <div className="student-status-head">
        <div>
          <h3>내 예약</h3>
          <p className="muted">{reservationSummary}</p>
        </div>
        <span className="student-status-chip" data-status={restricted ? "restricted" : "active"}>
          {statusLabel}
        </span>
      </div>
      {reservations.length > 0 ? (
        <ul className="student-status-list">
          {reservations.map((reservation) => {
            const current = currentReservationId === reservation.reservationId;
            return (
              <li key={reservation.reservationId}>
                <button
                  aria-current={current ? "true" : undefined}
                  aria-label={`${reservation.date} ${reservation.label} 예약 보기`}
                  className="student-status-reservation"
                  data-current={current}
                  type="button"
                  onClick={() => onSelectReservation?.(reservation)}
                >
                  <CalendarCheck aria-hidden="true" size={14} />
                  <span>{reservation.date}</span>
                  <strong>{reservation.label}</strong>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="student-status-summary">
        <span>{summaryLabel}</span>
        <strong>{nextReservableAtLabel(user)}</strong>
      </p>
    </section>
  );
}
