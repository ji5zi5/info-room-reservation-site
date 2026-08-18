"use client";

import { Download, RotateCcw, UserSearch, UserX, XCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import {
  ADMIN_RESERVATION_PERIOD_FILTERS,
  ADMIN_RESERVATION_STATUS_FILTERS,
  type AdminReservation,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter
} from "./admin-types";
import { AdminReservationCreateForm } from "./admin-reservation-create-form";
import { AdminBulkCancellationDialog, AdminConfirmationDialog } from "./admin-confirmation-dialog";
import type {
  AdminMutationResult,
  BulkCancellationData,
  BulkCancellationInput,
  CancelReservationData,
  NoShowReservationData
} from "./admin-api-client";
import type { AdminPaginationState } from "./admin-console-state";
import { bulkCancellationRetryableReservationIds } from "./admin-mutation-feedback";
import { AdminPaginationFooter } from "./admin-users-panel";

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

const MAX_BULK_SELECTION = 50;

export function AdminReservationsPanel({
  date,
  exportUrl,
  focusRecordId = null,
  onBulkCancelReservations = unavailableBulkCancellation,
  onCancelReservation,
  onCancellationRequestConsumed = noop,
  onLoadMore = noop,
  onMarkNoShow,
  onRefresh,
  onRestartTraversal = noop,
  onSelectStatus,
  onSetPeriod,
  onSetQuery,
  onViewUser,
  periodFilter,
  query,
  requestedCancellation = null,
  reservations,
  pagination = terminalPagination(reservations.length),
  statusFilter
}: {
  readonly date: string;
  readonly exportUrl: string;
  readonly focusRecordId?: string | null;
  readonly onBulkCancelReservations?: (input: BulkCancellationInput) => Promise<AdminMutationResult<BulkCancellationData>>;
  readonly onCancelReservation: (reservationId: string, reason: string) => Promise<AdminMutationResult<CancelReservationData>>;
  readonly onCancellationRequestConsumed?: () => void;
  readonly onLoadMore?: () => void;
  readonly onMarkNoShow: (reservationId: string) => Promise<AdminMutationResult<NoShowReservationData>>;
  readonly onRefresh: () => void;
  readonly onRestartTraversal?: () => void;
  readonly onSelectStatus: (status: AdminReservationStatusFilter) => void;
  readonly onSetPeriod: (period: AdminReservationStudyPeriodFilter) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onViewUser: (userId: string) => void;
  readonly periodFilter: AdminReservationStudyPeriodFilter;
  readonly query: string;
  readonly requestedCancellation?: AdminReservation | null;
  readonly reservations: readonly AdminReservation[];
  readonly pagination?: AdminPaginationState;
  readonly statusFilter: AdminReservationStatusFilter;
}): ReactElement {
  const [cancelDraft, setCancelDraft] = useState<AdminReservation | null>(requestedCancellation);
  const [cancelReason, setCancelReason] = useState("");
  const [bulkDialogOpen, setBulkDialogOpen] = useState(false);
  const [selectedReservations, setSelectedReservations] = useState<readonly AdminReservation[]>([]);
  const [noShowDraft, setNoShowDraft] = useState<AdminReservation | null>(null);
  const bulkActionRef = useRef<HTMLButtonElement>(null);
  const cancelReasonRef = useRef<HTMLTextAreaElement>(null);
  const focusRowRef = useRef<HTMLDivElement>(null);
  const trimmedCancelReason = cancelReason.trim();
  const selectedIds = new Set(selectedReservations.map((reservation) => reservation.id));

  useEffect(() => {
    if (requestedCancellation === null) {
      return;
    }
    openCancelDialog(requestedCancellation);
    onCancellationRequestConsumed();
  }, [onCancellationRequestConsumed, requestedCancellation]);

  useEffect(() => {
    focusRowRef.current?.focus();
  }, [focusRecordId, reservations]);

  useEffect(() => {
    setBulkDialogOpen(false);
    setSelectedReservations([]);
  }, [date, periodFilter, query, statusFilter]);

  useEffect(() => {
    const selectableIds = new Set(
      reservations
        .filter((reservation) => reservation.status === "CONFIRMED")
        .map((reservation) => reservation.id)
    );
    setSelectedReservations((current) => {
      const next = current.filter((reservation) => selectableIds.has(reservation.id));
      return next.length === current.length ? current : next;
    });
  }, [reservations]);

  function openCancelDialog(reservation: AdminReservation): void {
    setCancelDraft(reservation);
    setCancelReason("");
  }

  function closeCancelDialog(): void {
    setCancelDraft(null);
    setCancelReason("");
  }

  async function confirmCancelReservation(): Promise<AdminMutationResult<CancelReservationData>> {
    if (cancelDraft === null || !trimmedCancelReason) {
      return {
        kind: "error",
        message: "취소 사유를 입력하세요.",
        retryAfterMs: null,
        retryable: false,
        status: null
      };
    }
    return onCancelReservation(cancelDraft.id, trimmedCancelReason);
  }

  function toggleBulkSelection(reservation: AdminReservation, checked: boolean): void {
    setSelectedReservations((current) => {
      if (!checked) {
        return current.filter((candidate) => candidate.id !== reservation.id);
      }
      if (current.some((candidate) => candidate.id === reservation.id) || current.length >= MAX_BULK_SELECTION) {
        return current;
      }
      return [...current, reservation];
    });
  }

  function closeBulkDialog(): void {
    setBulkDialogOpen(false);
    window.requestAnimationFrame(() => bulkActionRef.current?.focus());
  }

  function applyBulkCancellationResult(result: BulkCancellationData): void {
    const retryableIds = new Set(bulkCancellationRetryableReservationIds(result));
    setSelectedReservations((current) => current.filter((reservation) => retryableIds.has(reservation.id)));
  }

  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>예약자 목록</h2>
        </div>
        <div className="admin-action-row">
          <a className="ghost-button" href={exportUrl}>
            <Download aria-hidden="true" size={18} />
            CSV 다운로드
          </a>
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
      <AdminReservationCreateForm date={date} onCreated={onRefresh} />
      <div className="status-filter" aria-label="예약 상태">
        {ADMIN_RESERVATION_STATUS_FILTERS.map((status) => (
          <button data-active={statusFilter === status} key={status} type="button" onClick={() => onSelectStatus(status)}>
            {STATUS_LABELS[status]}
          </button>
        ))}
      </div>
      <div className="bulk-cancellation-toolbar" aria-label="예약 일괄 작업">
        <span aria-live="polite">
          <strong>{selectedReservations.length}건 선택</strong>
          <span className="muted">최대 {MAX_BULK_SELECTION}건</span>
        </span>
        <div>
          <button
            className="ghost-button"
            disabled={selectedReservations.length === 0}
            type="button"
            onClick={() => setSelectedReservations([])}
          >
            선택 해제
          </button>
          <button
            aria-disabled={selectedReservations.length === 0}
            aria-haspopup="dialog"
            className="danger-button"
            ref={bulkActionRef}
            type="button"
            onClick={() => {
              if (selectedReservations.length > 0) {
                setBulkDialogOpen(true);
              }
            }}
          >
            <XCircle aria-hidden="true" size={16} />
            선택 취소
          </button>
        </div>
      </div>
      <div className="table-list">
        {reservations.map((reservation) => {
          const focusTarget = reservation.id === focusRecordId;
          return (
          <div
            className="table-line admin-reservation-line"
            data-focus-target={focusTarget ? "true" : undefined}
            key={reservation.id}
            ref={focusTarget ? focusRowRef : undefined}
            tabIndex={focusTarget ? -1 : undefined}
          >
            {reservation.status === "CONFIRMED" ? (
              <input
                aria-label={`${reservation.user.name} 예약 선택`}
                checked={selectedIds.has(reservation.id)}
                disabled={!selectedIds.has(reservation.id) && selectedReservations.length >= MAX_BULK_SELECTION}
                type="checkbox"
                onChange={(event) => toggleBulkSelection(reservation, event.currentTarget.checked)}
              />
            ) : <span aria-hidden="true" className="bulk-selection-spacer" />}
            <div>
              <strong>{reservation.user.name}</strong>
              <p className="muted">{reservation.user.studentNumber}</p>
              <p className="muted">사유 {reservationReasonLabel(reservation.reason)}</p>
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
                  <button aria-haspopup="dialog" className="ghost-button" type="button" onClick={() => openCancelDialog(reservation)}>
                    <XCircle size={16} />
                    취소
                  </button>
                  <button aria-haspopup="dialog" className="danger-button" type="button" onClick={() => setNoShowDraft(reservation)}>
                    <UserX size={16} />
                    노쇼
                  </button>
                </>
              ) : null}
            </div>
          </div>
          );
        })}
        {reservations.length === 0 ? <div className="table-line muted">아직 예약자가 없습니다.</div> : null}
      </div>
      <AdminPaginationFooter
        onLoadMore={onLoadMore}
        onRestartTraversal={onRestartTraversal}
        pagination={pagination}
      />
      {cancelDraft ? (
        <AdminConfirmationDialog
          cancelLabel="닫기"
          confirmDisabled={!trimmedCancelReason}
          confirmLabel="취소 확정"
          initialFocusRef={cancelReasonRef}
          onConfirm={confirmCancelReservation}
          onDismiss={closeCancelDialog}
          title="예약을 관리자 취소할까요?"
        >
          <p className="muted">입력한 사유는 학생 알림과 감사 기록에 남습니다.</p>
          <div className="cancel-policy-preview">
            <p>
              <strong>{cancelDraft.user.name}</strong>
              <span className="muted">{cancelDraft.date} {studyPeriodLabel(cancelDraft.studyPeriod)}</span>
            </p>
          </div>
          <label className="field">
            <span>취소 사유</span>
            <textarea
              maxLength={200}
              ref={cancelReasonRef}
              rows={3}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.currentTarget.value)}
            />
          </label>
        </AdminConfirmationDialog>
      ) : null}
      {bulkDialogOpen && selectedReservations.length > 0 ? (
        <AdminBulkCancellationDialog
          onDismiss={closeBulkDialog}
          onExecuted={applyBulkCancellationResult}
          onMutate={onBulkCancelReservations}
          reservations={selectedReservations}
        />
      ) : null}
      {noShowDraft ? (
        <AdminConfirmationDialog
          cancelLabel="돌아가기"
          confirmLabel="노쇼 처리"
          onConfirm={() => onMarkNoShow(noShowDraft.id)}
          onDismiss={() => setNoShowDraft(null)}
          title="노쇼로 처리할까요?"
        >
          <p className="muted">노쇼 처리하면 학생은 영구 제한됩니다.</p>
        </AdminConfirmationDialog>
      ) : null}
    </section>
  );
}

function noop(): void {}

async function unavailableBulkCancellation(): Promise<AdminMutationResult<BulkCancellationData>> {
  return {
    kind: "error",
    message: "예약 일괄 취소를 사용할 수 없습니다.",
    retryAfterMs: null,
    retryable: false,
    status: null
  };
}

function terminalPagination(loadedCount: number): AdminPaginationState {
  return {
    currentTotalCount: loadedCount,
    hasHiddenPrevious: false,
    loadedCount,
    loadingMore: false,
    nextCursor: null,
    restartRequired: false
  };
}

function reservationReasonLabel(reason: string | null): string {
  const normalized = reason?.trim();
  return normalized ? normalized : "미기록";
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

function studyPeriodLabel(studyPeriod: string): string {
  return studyPeriod === "EIGHTH" ? "8면학" : "1면학";
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
