"use client";

import { ShieldOff, UserX, X } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import { parseShadowBanProfile, shadowBanProfileLabel } from "@/lib/shadow-ban-profile";
import { adminAccountDescription, adminAccountName } from "./admin-account-labels";
import type { UserRestrictionDraft } from "./admin-console-state";
import {
  actionLabel,
  formatKst,
  periodLabel,
  reservationReasonLabel,
  sanctionStatusLabel,
  sanctionStatusTimestamp,
  sanctionTypeLabel,
  statusLabel
} from "./admin-student-detail-labels";
import { AdminStudentRestrictionForm } from "./admin-student-restriction-form";
import { AdminConfirmationDialog } from "./admin-confirmation-dialog";
import type { AdminMutationResult, ApplyRestrictionData, NoShowReservationData } from "./admin-api-client";
import type { AdminUserDetail } from "./admin-types";

export function AdminStudentDetail({
  detail,
  onApplyRestriction,
  onClose,
  onMarkNoShow,
  onRelease,
  onSetRestrictionDraft,
  restrictionDraft
}: {
  readonly detail: AdminUserDetail | null;
  readonly onApplyRestriction: (userId: string) => Promise<AdminMutationResult<ApplyRestrictionData>>;
  readonly onClose?: () => void;
  readonly onMarkNoShow: (reservationId: string) => Promise<AdminMutationResult<NoShowReservationData>>;
  readonly onRelease: (userId: string) => void;
  readonly onSetRestrictionDraft: (userId: string, patch: Partial<UserRestrictionDraft>) => void;
  readonly restrictionDraft: UserRestrictionDraft;
}): ReactElement | null {
  const [noShowReservationId, setNoShowReservationId] = useState<string | null>(null);
  if (!detail) {
    return null;
  }

  const visibleSanctions = detail.sanctions.slice(0, 30);

  return (
    <aside className="student-detail-panel" data-open="true">
      <div className="student-detail-head">
        <div>
          <span className="status-chip" data-status={detail.user.bookingStatus}>{statusLabel(detail.user.bookingStatus)}</span>
          <h3>{adminAccountName(detail.user)}</h3>
          <p className="muted">{adminAccountDescription(detail.user)}</p>
        </div>
        {onClose ? (
          <button className="icon-button" type="button" aria-label="학생 상세 닫기" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        ) : null}
      </div>
      <div className="detail-metrics">
        <span>확정 {detail.summary.confirmedCount}</span>
        <span>노쇼 {detail.summary.noShowCount}</span>
        <span>취소 {detail.summary.cancelledCount}</span>
        <span>최근 최대 100건 기준</span>
      </div>
      <div className="notice-panel">
        <strong>현재 상태</strong>
        <p className="muted">{detail.user.restrictionReason ?? "제한 사유 없음"}</p>
        {detail.user.bookingStatus === "SHADOW_BANNED" ? (
          <p className="muted">블랙리스트 강도 {shadowBanProfileLabel(parseShadowBanProfile(detail.user.shadowBanProfile))}</p>
        ) : null}
        {detail.user.restrictedUntil ? <p className="muted">제한 종료 {formatKst(detail.user.restrictedUntil)}</p> : null}
        <p className="muted">
          최근 조회 제재 {detail.sanctionSummary.totalCount}회 · 활성 {detail.sanctionSummary.activeCount}회 · 해제{" "}
          {detail.sanctionSummary.revokedCount}회
        </p>
      </div>
      <AdminStudentRestrictionForm
        draft={restrictionDraft}
        onApply={() => onApplyRestriction(detail.user.id)}
        onSetDraft={(patch) => onSetRestrictionDraft(detail.user.id, patch)}
      />
      {detail.user.bookingStatus !== "ACTIVE" ? (
        <div className="detail-actions">
          <button className="primary-button" type="button" onClick={() => onRelease(detail.user.id)}>
            <ShieldOff size={16} />
            제한 해제
          </button>
        </div>
      ) : null}
      <DetailSection title="현재 예약">
        {detail.currentReservations.length > 0 ? (
          detail.currentReservations.map((reservation) => (
            <DetailLine
              key={reservation.id}
              action={
                reservation.status === "CONFIRMED" ? (
                  <button
                    aria-haspopup="dialog" className="danger-button detail-line-action" data-reservation-action={reservation.id} type="button"
                    onClick={() => setNoShowReservationId(reservation.id)}
                  >
                    <UserX size={16} />
                    노쇼
                  </button>
                ) : undefined
              }
              left={`${periodLabel(reservation.studyPeriod)} · ${reservationReasonLabel(reservation.reason)}`}
              right={reservation.date}
            />
          ))
        ) : (
          <p className="muted">현재 예약 없음</p>
        )}
      </DetailSection>
      <DetailSection title="예약 이력 · 최근 12건 표시">
        {detail.reservationHistory.slice(0, 12).map((reservation) => (
          <DetailLine
            key={reservation.id}
            left={`${reservation.date} · ${periodLabel(reservation.studyPeriod)} · ${reservationReasonLabel(reservation.reason)}`}
            right={statusLabel(reservation.status)}
          />
        ))}
      </DetailSection>
      <DetailSection title="제재 이력 · 최근 최대 30건">
        {visibleSanctions.length > 0 ? (
          visibleSanctions.map((sanction) => (
            <DetailLine
              key={sanction.id}
              left={`${sanctionTypeLabel(sanction.type)} · ${sanction.reason}`}
              right={`${sanctionStatusLabel(sanction.status)} · ${formatKst(sanctionStatusTimestamp(sanction))}`}
            />
          ))
        ) : (
          <p className="muted">제재 이력 없음</p>
        )}
      </DetailSection>
      <DetailSection title="관리자 액션 · 최근 12건 표시 · 최대 30건 조회">
        {detail.adminActions.length > 0 ? (
          detail.adminActions.slice(0, 12).map((action) => (
            <DetailLine
              key={action.id}
              left={`${actionLabel(action.action)}${action.reason ? ` · ${action.reason}` : ""}`}
              right={formatKst(action.createdAt)}
            />
          ))
        ) : (
          <p className="muted">액션 기록 없음</p>
        )}
      </DetailSection>
      <DetailSection title="감사 로그 · 최근 최대 20건">
        {detail.auditLogs.length > 0 ? (
          detail.auditLogs.map((log) => <DetailLine key={log.id} left={actionLabel(log.action)} right={formatKst(log.createdAt)} />)
        ) : (
          <p className="muted">아직 로그 없음</p>
        )}
      </DetailSection>
      {noShowReservationId ? (
        <AdminConfirmationDialog
          cancelLabel="돌아가기"
          confirmLabel="노쇼 처리"
          onConfirm={() => onMarkNoShow(noShowReservationId)}
          onDismiss={() => setNoShowReservationId(null)}
          title="노쇼로 처리할까요?"
        >
          <p className="muted">노쇼 처리하면 학생은 영구 제한됩니다.</p>
        </AdminConfirmationDialog>
      ) : null}
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

function DetailLine({
  action,
  left,
  right
}: {
  readonly action?: ReactNode;
  readonly left: ReactNode;
  readonly right: ReactNode;
}): ReactElement {
  return (
    <div className="detail-line" data-action={action ? "true" : undefined}>
      <span>{left}</span>
      <strong>{right}</strong>
      {action}
    </div>
  );
}
