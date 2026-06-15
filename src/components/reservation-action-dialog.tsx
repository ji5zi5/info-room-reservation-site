import { AlertTriangle, X } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { formatKstDateTime } from "@/lib/student-reservation-status";

export type ReservationPendingAction =
  | {
      readonly kind: "cancel";
      readonly label: string;
      readonly reservationId: string;
      readonly restrictedUntilPreview: string;
    }
  | {
      readonly kind: "reserve";
      readonly label: string;
      readonly studyPeriod: "EIGHTH" | "FIRST";
    };

export type ReservationActionConfirmInput =
  | { readonly kind: "cancel" }
  | { readonly kind: "reserve"; readonly reason: string };

type ReservationActionDialogProps = {
  readonly action: ReservationPendingAction | null;
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (input: ReservationActionConfirmInput) => void;
};

const RESERVATION_REASON_PRESETS = ["자습", "과제", "프린트/자료", "기타"] as const;

export function ReservationActionDialog({
  action,
  loading,
  onClose,
  onConfirm
}: ReservationActionDialogProps): ReactElement | null {
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [reservationReason, setReservationReason] = useState("");

  useEffect(() => {
    setCancelConfirmed(false);
    setReservationReason("");
  }, [action]);

  if (!action) {
    return null;
  }

  const isCancel = action.kind === "cancel";
  const trimmedReason = reservationReason.trim();
  const confirmDisabled = loading || (isCancel ? !cancelConfirmed : trimmedReason.length === 0);

  return (
    <div className="confirm-backdrop" role="presentation">
      <section
        aria-describedby="reservation-confirm-description"
        aria-labelledby="reservation-confirm-title"
        aria-modal="true"
        className="confirm-dialog"
        data-kind={action.kind}
        role="dialog"
      >
        <button aria-label="확인 창 닫기" className="icon-button confirm-close" type="button" onClick={onClose}>
          <X size={18} />
        </button>
        {isCancel ? (
          <div className="confirm-mark" aria-hidden="true">
            <AlertTriangle size={22} />
          </div>
        ) : null}
        <h3 id="reservation-confirm-title">{isCancel ? "예약을 취소할까요?" : `${action.label} 예약할까요?`}</h3>
        <p id="reservation-confirm-description" className="muted">
          {isCancel
            ? "취소하면 3일간 예약이 제한됩니다."
            : "이용 사유를 입력하면 신청됩니다."}
        </p>
        {isCancel ? (
          <div className="cancel-policy-preview">
            <p>
              <strong>제한 해제 예정</strong>
              <span>{formatKstDateTime(action.restrictedUntilPreview)}</span>
            </p>
            <p className="muted">
              학생 직접 취소는 3일 예약 제한과 제재 기록이 남습니다. 관리자 취소는 운영자가 처리하며 학생 직접 취소 제한을 적용하지 않습니다.
            </p>
            <label className="confirm-check">
              <input
                checked={cancelConfirmed}
                disabled={loading}
                type="checkbox"
                onChange={(event) => setCancelConfirmed(event.currentTarget.checked)}
              />
              <span>정말 취소하려면 이 확인란을 선택하세요.</span>
            </label>
          </div>
        ) : (
          <div className="reservation-reason-form">
            <label className="field">
              <span>이용 사유</span>
              <input
                autoFocus
                maxLength={80}
                placeholder="예: 자습, 과제, 자료 출력"
                value={reservationReason}
                onChange={(event) => setReservationReason(event.currentTarget.value)}
              />
            </label>
            <div className="reason-preset-row" aria-label="빠른 사유">
              {RESERVATION_REASON_PRESETS.map((preset) => (
                <button
                  className="reason-preset-button"
                  data-active={trimmedReason === preset}
                  disabled={loading}
                  key={preset}
                  type="button"
                  onClick={() => setReservationReason(preset)}
                >
                  {preset}
                </button>
              ))}
            </div>
            <p className="confirm-policy-note">미참석 시 정보실 예약이 영구 제한됩니다.</p>
          </div>
        )}
        <div className="confirm-actions">
          <button className="ghost-button" disabled={loading} type="button" onClick={onClose}>
            닫기
          </button>
          <button
            className="primary-button danger-aware"
            disabled={confirmDisabled}
            type="button"
            onClick={() => onConfirm(isCancel ? { kind: "cancel" } : { kind: "reserve", reason: trimmedReason })}
          >
            {loading ? "처리 중" : isCancel ? "취소 확정" : "신청하기"}
          </button>
        </div>
      </section>
    </div>
  );
}
