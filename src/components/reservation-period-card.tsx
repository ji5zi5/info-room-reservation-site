import { Check } from "lucide-react";
import type { ReactElement } from "react";

import type { StudentPeriodSummary } from "@/lib/student-period-summary";

export type PeriodSummary = StudentPeriodSummary;

type ReservationPeriodCardProps = {
  readonly loading: boolean;
  readonly onCancel: (reservationId: string) => void;
  readonly onReserve: (studyPeriod: "EIGHTH" | "FIRST") => void;
  readonly period: PeriodSummary;
  readonly userReady: boolean;
};

export function ReservationPeriodCard({
  loading,
  onCancel,
  onReserve,
  period,
  userReady
}: ReservationPeriodCardProps): ReactElement {
  const currentReservationId = period.myReservationId;
  const reserved = currentReservationId !== null;
  const periodAvailable = period.enabled && period.remaining > 0 && period.windowState === "open";
  const reserveDisabled =
    reserved || !userReady || loading || period.remaining <= 0 || !period.enabled || period.windowState !== "open";
  const reserveButtonLabel = reserved
    ? "예약됨"
    : !period.enabled
      ? "비활성"
      : period.windowState === "closed" || period.remaining <= 0
        ? "마감"
        : period.windowState === "not_open_yet"
          ? "대기"
          : `${period.label} 예약`;

  return (
    <article className="period-card">
      <div className="period-top">
        <div className="period-title">
          <span className="period-badge">{period.label}</span>
          <div>
            <h3>{period.openTime} 오픈</h3>
            <p className="muted">{period.closeTime} 마감 · 남은 자리 {period.remaining}/{period.capacity}</p>
          </div>
        </div>
        <Check aria-hidden="true" className="period-state-icon" data-active={periodAvailable ? "true" : "false"} />
      </div>
      <div className="meter">
        <span style={{ width: `${Math.round((period.confirmedCount / period.capacity) * 100)}%` }} />
      </div>
      <div className="period-actions">
        <button
          className="period-button"
          disabled={reserveDisabled}
          type="button"
          onClick={() => onReserve(period.studyPeriod)}
        >
          {reserveButtonLabel}
        </button>
        {currentReservationId ? (
          <button
            className="ghost-button"
            disabled={loading}
            type="button"
            onClick={() => onCancel(currentReservationId)}
          >
            예약 취소
          </button>
        ) : null}
      </div>
    </article>
  );
}
