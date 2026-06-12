"use client";

import { RotateCcw, UserX } from "lucide-react";

import {
  ADMIN_RESERVATION_STATUS_FILTERS,
  type AdminReservation,
  type AdminReservationStatusFilter
} from "./admin-types";

const STATUS_LABELS: Record<AdminReservationStatusFilter, string> = {
  ALL: "전체",
  CANCELLED: "취소",
  CONFIRMED: "확정",
  NO_SHOW: "노쇼"
};

export function AdminReservationsPanel({
  onMarkNoShow,
  onRefresh,
  onSelectStatus,
  reservations,
  statusFilter
}: {
  readonly onMarkNoShow: (reservationId: string) => void;
  readonly onRefresh: () => void;
  readonly onSelectStatus: (status: AdminReservationStatusFilter) => void;
  readonly reservations: readonly AdminReservation[];
  readonly statusFilter: AdminReservationStatusFilter;
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>예약자 목록</h2>
          <p className="muted">노쇼 · 상태 필터</p>
        </div>
        <button className="ghost-button" type="button" onClick={onRefresh}>
          <RotateCcw size={18} />
          새로고침
        </button>
      </div>
      <div className="status-filter" aria-label="예약 상태">
        {ADMIN_RESERVATION_STATUS_FILTERS.map((status) => (
          <button data-active={statusFilter === status} key={status} type="button" onClick={() => onSelectStatus(status)}>
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>
      <div className="table-list">
        {reservations.map((reservation) => (
          <div className="table-line" key={reservation.id}>
            <div>
              <strong>{reservation.user.name}</strong>
              <p className="muted">{reservation.user.studentNumber}</p>
            </div>
            <span>{reservation.studyPeriod === "EIGHTH" ? "8면학" : "1면학"}</span>
            <span>{statusLabel(reservation.status)}</span>
            <div className="row">
              {reservation.status === "CONFIRMED" ? (
                <button className="danger-button" type="button" onClick={() => onMarkNoShow(reservation.id)}>
                  <UserX size={16} />
                  노쇼
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {reservations.length === 0 ? <div className="table-line muted">아직 예약자가 없습니다.</div> : null}
      </div>
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "CANCELLED":
      return STATUS_LABELS.CANCELLED;
    case "CONFIRMED":
      return STATUS_LABELS.CONFIRMED;
    case "NO_SHOW":
      return STATUS_LABELS.NO_SHOW;
    default:
      return status;
  }
}
