"use client";

import { ClipboardList, RotateCcw, UserSearch, UserX, XCircle } from "lucide-react";

import {
  ADMIN_RESERVATION_PERIOD_FILTERS,
  ADMIN_RESERVATION_STATUS_FILTERS,
  type AdminReservation,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter
} from "./admin-types";

const STATUS_LABELS: Record<AdminReservationStatusFilter, string> = {
  ALL: "전체",
  CANCELLED: "취소",
  CONFIRMED: "확정",
  NO_SHOW: "노쇼"
};

const PERIOD_FILTER_LABELS: Record<AdminReservationStudyPeriodFilter, string> = {
  ALL: "전체",
  EIGHTH: "8면학",
  FIRST: "1면학"
};

export function AdminReservationsPanel({
  onCancelReservation,
  onCopyCsv,
  onMarkNoShow,
  onRefresh,
  onSelectStatus,
  onSetPeriod,
  onSetQuery,
  onViewUser,
  periodFilter,
  query,
  reservations,
  statusFilter
}: {
  readonly onCancelReservation: (reservationId: string) => void;
  readonly onCopyCsv: () => void;
  readonly onMarkNoShow: (reservationId: string) => void;
  readonly onRefresh: () => void;
  readonly onSelectStatus: (status: AdminReservationStatusFilter) => void;
  readonly onSetPeriod: (period: AdminReservationStudyPeriodFilter) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onViewUser: (userId: string) => void;
  readonly periodFilter: AdminReservationStudyPeriodFilter;
  readonly query: string;
  readonly reservations: readonly AdminReservation[];
  readonly statusFilter: AdminReservationStatusFilter;
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>예약자 목록</h2>
          <p className="muted">검색 · 노쇼 · 관리자 취소 · 명단 복사</p>
        </div>
        <div className="admin-action-row">
          <button className="ghost-button" type="button" onClick={onCopyCsv}>
            <ClipboardList size={18} />
            명단 복사
          </button>
          <button className="ghost-button" type="button" onClick={onRefresh}>
            <RotateCcw size={18} />
            새로고침
          </button>
        </div>
      </div>
      <div className="admin-row">
        <label className="field grow-field">
          <span>이름 또는 학번</span>
          <input value={query} onChange={(event) => onSetQuery(event.currentTarget.value)} />
        </label>
        <label className="field">
          <span>시간대</span>
          <select value={periodFilter} onChange={(event) => onSetPeriod(parsePeriodFilter(event.currentTarget.value))}>
            {ADMIN_RESERVATION_PERIOD_FILTERS.map((period) => (
              <option key={period} value={period}>{PERIOD_FILTER_LABELS[period]}</option>
            ))}
          </select>
        </label>
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
              <button className="ghost-button" type="button" onClick={() => onViewUser(reservation.user.id)}>
                <UserSearch size={16} />
                학생
              </button>
              {reservation.status === "CONFIRMED" ? (
                <>
                  <button className="ghost-button" type="button" onClick={() => onCancelReservation(reservation.id)}>
                    <XCircle size={16} />
                    취소
                  </button>
                  <button className="danger-button" type="button" onClick={() => onMarkNoShow(reservation.id)}>
                    <UserX size={16} />
                    노쇼
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ))}
        {reservations.length === 0 ? <div className="table-line muted">아직 예약자가 없습니다.</div> : null}
      </div>
    </section>
  );
}

function parsePeriodFilter(value: string): AdminReservationStudyPeriodFilter {
  switch (value) {
    case "EIGHTH":
      return "EIGHTH";
    case "FIRST":
      return "FIRST";
    case "ALL":
    default:
      return "ALL";
  }
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
