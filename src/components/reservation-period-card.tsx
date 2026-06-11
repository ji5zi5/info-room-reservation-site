import { Check } from "lucide-react";
import type { ReactElement } from "react";

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
  readonly openTime: string;
  readonly remaining: number;
  readonly studyPeriod: "EIGHTH" | "FIRST";
};

type ReservationPeriodCardProps = {
  readonly loading: boolean;
  readonly onReserve: (studyPeriod: "EIGHTH" | "FIRST") => void;
  readonly period: PeriodSummary;
  readonly userReady: boolean;
};

export function ReservationPeriodCard({
  loading,
  onReserve,
  period,
  userReady
}: ReservationPeriodCardProps): ReactElement {
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
        <Check color={period.remaining > 0 ? "#3E6AE1" : "#5C5E62"} />
      </div>
      <div className="meter">
        <span style={{ width: `${Math.round((period.confirmedCount / period.capacity) * 100)}%` }} />
      </div>
      <ApplicantList applicants={period.applicants} />
      <button
        className="period-button"
        disabled={!userReady || loading || period.remaining <= 0 || !period.enabled}
        type="button"
        onClick={() => onReserve(period.studyPeriod)}
      >
        {period.remaining <= 0 ? "마감" : `${period.label} 예약`}
      </button>
    </article>
  );
}

function ApplicantList({ applicants }: { readonly applicants: readonly PeriodApplicant[] }): ReactElement {
  return (
    <div className="applicant-list">
      <div className="applicant-head">
        <span>신청자</span>
        <span>{applicants.length}명</span>
      </div>
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
  );
}
