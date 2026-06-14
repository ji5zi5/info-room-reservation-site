import { Check, ChevronDown } from "lucide-react";
import type { ReactElement } from "react";
import { useId, useState } from "react";

export type PeriodApplicant = {
  readonly name: string;
  readonly reservationId: string;
  readonly studentNumber: string;
};

export type PeriodSummary = {
  readonly applicants: readonly PeriodApplicant[];
  readonly capacity: number;
  readonly closeTime: string;
  readonly confirmedCount: number;
  readonly date: string;
  readonly enabled: boolean;
  readonly label: string;
  readonly myReservationId: string | null;
  readonly openTime: string;
  readonly remaining: number;
  readonly studyPeriod: "EIGHTH" | "FIRST";
  readonly windowState: "closed" | "not_open_yet" | "open";
};

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
        <Check color={period.enabled && period.remaining > 0 && period.windowState === "open" ? "#3E6AE1" : "#5C5E62"} />
      </div>
      <div className="meter">
        <span style={{ width: `${Math.round((period.confirmedCount / period.capacity) * 100)}%` }} />
      </div>
      <ApplicantList applicants={period.applicants} period={period} />
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

function ApplicantList({
  applicants,
  period
}: {
  readonly applicants: readonly PeriodApplicant[];
  readonly period: PeriodSummary;
}): ReactElement {
  const [applicantsOpen, setApplicantsOpen] = useState(false);
  const generatedId = useId();
  const contentId = `applicants-${period.date}-${period.studyPeriod}-${generatedId}`;

  return (
    <div className="applicant-list" data-open={applicantsOpen}>
      <button
        aria-controls={contentId}
        aria-expanded={applicantsOpen}
        className="applicant-toggle"
        type="button"
        onClick={() => setApplicantsOpen((open) => !open)}
      >
        <span aria-hidden="true">신청자</span>
        <span>{applicantsOpen ? "신청자 접기" : `신청자 ${applicants.length}명 보기`}</span>
        <ChevronDown aria-hidden="true" size={18} />
      </button>
      <div aria-hidden={!applicantsOpen} className="applicant-content" id={contentId}>
        {applicants.length > 0 ? (
          <ul>
            {applicants.map((applicant) => (
              <li key={applicant.reservationId}>
                <strong>{applicant.name}</strong>
                <span>{applicant.studentNumber}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">아직 신청자 없음</p>
        )}
      </div>
    </div>
  );
}
