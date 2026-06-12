"use client";

import { Ban, CalendarCheck, ShieldOff, UserRoundCheck } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import type { AdminUserDetail } from "./admin-types";

export function AdminStudentDetail({
  detail,
  onApplyPreset,
  onBan,
  onClose,
  onRelease
}: {
  readonly detail: AdminUserDetail | null;
  readonly onApplyPreset: (userId: string, days: number) => void;
  readonly onBan: (userId: string) => void;
  readonly onClose?: () => void;
  readonly onRelease: (userId: string) => void;
}): ReactElement {
  if (!detail) {
    return (
      <aside className="student-detail-panel empty-detail">
        <UserRoundCheck size={22} />
        <h3>학생 선택</h3>
        <p className="muted">학생 목록이나 예약자 목록에서 학생을 선택하면 상세 이력과 제재 액션이 열립니다.</p>
      </aside>
    );
  }

  return (
    <aside className="student-detail-panel" data-open="true">
      <div className="student-detail-head">
        <div>
          <span className="status-chip" data-status={detail.user.bookingStatus}>{statusLabel(detail.user.bookingStatus)}</span>
          <h3>{detail.user.name}</h3>
          <p className="muted">{detail.user.studentNumber} · {detail.user.generation}기</p>
        </div>
        {onClose ? <button className="icon-button" type="button" aria-label="학생 상세 닫기" onClick={onClose}>×</button> : null}
      </div>
      <div className="detail-metrics">
        <span>확정 {detail.summary.confirmedCount}</span>
        <span>노쇼 {detail.summary.noShowCount}</span>
        <span>취소 {detail.summary.cancelledCount}</span>
      </div>
      <div className="notice-panel">
        <strong>현재 상태</strong>
        <p className="muted">{detail.user.restrictionReason ?? "제한 사유 없음"}</p>
        {detail.user.restrictedUntil ? <p className="muted">제한 종료 {formatKst(detail.user.restrictedUntil)}</p> : null}
      </div>
      <div className="detail-actions">
        <button className="ghost-button" type="button" onClick={() => onApplyPreset(detail.user.id, 7)}>
          <CalendarCheck size={16} />
          7일 제한
        </button>
        <button className="ghost-button" type="button" onClick={() => onApplyPreset(detail.user.id, 14)}>14일 제한</button>
        <button className="ghost-button" type="button" onClick={() => onApplyPreset(detail.user.id, 30)}>30일 제한</button>
        <button className="danger-button" type="button" onClick={() => onBan(detail.user.id)}>
          <Ban size={16} />
          영구 차단
        </button>
        {detail.user.bookingStatus !== "ACTIVE" ? (
          <button className="primary-button" type="button" onClick={() => onRelease(detail.user.id)}>
            <ShieldOff size={16} />
            제한 해제
          </button>
        ) : null}
      </div>
      <DetailSection title="현재 예약">
        {detail.currentReservations.length > 0 ? (
          detail.currentReservations.map((reservation) => (
            <DetailLine key={reservation.id} left={periodLabel(reservation.studyPeriod)} right={reservation.date} />
          ))
        ) : (
          <p className="muted">현재 예약 없음</p>
        )}
      </DetailSection>
      <DetailSection title="예약 이력">
        {detail.reservationHistory.slice(0, 12).map((reservation) => (
          <DetailLine
            key={reservation.id}
            left={`${reservation.date} · ${periodLabel(reservation.studyPeriod)}`}
            right={statusLabel(reservation.status)}
          />
        ))}
      </DetailSection>
      <DetailSection title="감사 로그">
        {detail.auditLogs.length > 0 ? (
          detail.auditLogs.map((log) => <DetailLine key={log.id} left={log.action} right={formatKst(log.createdAt)} />)
        ) : (
          <p className="muted">아직 로그 없음</p>
        )}
      </DetailSection>
    </aside>
  );
}

function DetailSection({ children, title }: { readonly children: ReactNode; readonly title: string }): ReactElement {
  return (
    <section className="detail-section">
      <h4>{title}</h4>
      <div className="detail-lines">{children}</div>
    </section>
  );
}

function DetailLine({ left, right }: { readonly left: string; readonly right: string }): ReactElement {
  return (
    <div className="detail-line">
      <span>{left}</span>
      <strong>{right}</strong>
    </div>
  );
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

function statusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "정상";
    case "BANNED":
      return "차단";
    case "CANCELLED":
      return "취소";
    case "CONFIRMED":
      return "확정";
    case "NO_SHOW":
      return "노쇼";
    case "RESTRICTED":
      return "제한";
    default:
      return status;
  }
}

function formatKst(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul"
  }).format(new Date(value));
}
