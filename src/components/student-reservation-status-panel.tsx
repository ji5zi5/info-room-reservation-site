"use client";

import { Clock3, MessageSquareText } from "lucide-react";
import type { ReactElement } from "react";

import {
  buildStudentInquiryCode,
  isStudentRestrictionActive,
  nextReservableAtLabel,
  restrictionDetailLabel,
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
  const statusLabel = studentReservationStatusLabel(user);

  return (
    <section aria-label="내 예약 상태" className="student-status-panel">
      <div className="student-status-head">
        <div>
          <h3>내 예약 상태</h3>
          <p className="muted">{reservations.length > 0 ? `${reservations.length}건 확인됨` : "현재 예약 없음"}</p>
        </div>
        <span className="student-status-chip" data-status={restricted ? "restricted" : "active"}>
          {statusLabel}
        </span>
      </div>
      <dl className="student-status-list">
        <StatusLine
          label="현재 예약"
          value={reservations.length > 0 ? reservations.map(formatReservation).join(" / ") : "현재 예약 없음"}
        />
        <StatusLine label="취소 가능 여부" value={reservations.some((reservation) => reservation.canCancel) ? "취소 가능" : "취소할 예약 없음"} />
        <StatusLine label="예약 제한 상태" value={restrictionDetailLabel(user)} />
        <StatusLine label="제한 사유" value={user.restrictionReason ?? "제한 사유 없음"} />
        <StatusLine label="다음 예약 가능" value={nextReservableAtLabel(user)} icon={<Clock3 aria-hidden="true" size={14} />} />
        <StatusLine label="문의 코드" value={buildStudentInquiryCode(user)} icon={<MessageSquareText aria-hidden="true" size={14} />} />
      </dl>
    </section>
  );
}

function StatusLine({
  icon,
  label,
  value
}: {
  readonly icon?: ReactElement;
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {icon}
        <span>{value}</span>
      </dd>
    </div>
  );
}

function formatReservation(reservation: StudentCurrentReservation): string {
  return `${reservation.date} · ${reservation.label} · 확정`;
}
