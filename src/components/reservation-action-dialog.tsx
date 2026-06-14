import { AlertTriangle, X } from "lucide-react";
import type { ReactElement } from "react";

export type ReservationPendingAction =
  | {
      readonly kind: "cancel";
      readonly label: string;
      readonly reservationId: string;
    }
  | {
      readonly kind: "reserve";
      readonly label: string;
      readonly studyPeriod: "EIGHTH" | "FIRST";
    };

type ReservationActionDialogProps = {
  readonly action: ReservationPendingAction | null;
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
};

export function ReservationActionDialog({
  action,
  loading,
  onClose,
  onConfirm
}: ReservationActionDialogProps): ReactElement | null {
  if (!action) {
    return null;
  }

  const isCancel = action.kind === "cancel";

  return (
    <div className="confirm-backdrop" role="presentation">
      <section
        aria-describedby="reservation-confirm-description"
        aria-labelledby="reservation-confirm-title"
        aria-modal="true"
        className="confirm-dialog"
        role="dialog"
      >
        <button aria-label="확인 창 닫기" className="icon-button confirm-close" type="button" onClick={onClose}>
          <X size={18} />
        </button>
        <div className="confirm-mark" aria-hidden="true">
          <AlertTriangle size={22} />
        </div>
        <h3 id="reservation-confirm-title">{isCancel ? "예약을 취소할까요?" : `${action.label} 예약할까요?`}</h3>
        <p id="reservation-confirm-description" className="muted">
          {isCancel
            ? "예약 취소 시 3일간 예약이 제한됩니다."
            : "신청 후 미참석 시 정보실 예약이 영구 제한됩니다."}
        </p>
        <div className="confirm-actions">
          <button className="ghost-button" disabled={loading} type="button" onClick={onClose}>
            닫기
          </button>
          <button className="primary-button danger-aware" disabled={loading} type="button" onClick={onConfirm}>
            {loading ? "처리 중" : isCancel ? "취소 확정" : "예약 확정"}
          </button>
        </div>
      </section>
    </div>
  );
}
