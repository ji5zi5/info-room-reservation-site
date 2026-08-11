import { AlertTriangle, X } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatKstDateTime } from "@/lib/student-reservation-status";
import { useDialogFocus } from "./use-dialog-focus";

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

export type ReservationActionOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "error" };

type ReservationActionDialogProps = {
  readonly action: ReservationPendingAction | null;
  readonly errorMessage: string | null;
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (input: ReservationActionConfirmInput) => Promise<ReservationActionOutcome>;
  readonly onRefreshRetry?: () => void;
  readonly refreshRetrying?: boolean;
};

export function ReservationActionDialog({
  action,
  errorMessage,
  loading,
  onClose,
  onConfirm,
  onRefreshRetry,
  refreshRetrying = false
}: ReservationActionDialogProps): ReactElement | null {
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [restoreConfirmFocus, setRestoreConfirmFocus] = useState(false);
  const [reservationReason, setReservationReason] = useState("");
  const cancelConfirmationRef = useRef<HTMLInputElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const confirmingRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const refreshRetryActivatedRef = useRef(false);
  const pending = loading || confirming;
  const refreshRetryVisible = onRefreshRetry !== undefined;
  const initialFocusRef = action?.kind === "cancel" ? cancelConfirmationRef : reasonRef;

  useDialogFocus({
    canDismiss: !pending,
    dialogRef,
    initialFocusKey: action ? `${action.kind}:${action.kind === "cancel" ? action.reservationId : action.studyPeriod}` : "closed",
    initialFocusRef,
    onDismiss: onClose,
    open: action !== null
  });

  useEffect(() => {
    setCancelConfirmed(false);
    setConfirming(false);
    setRestoreConfirmFocus(false);
    confirmingRef.current = false;
    setReservationReason("");
  }, [action]);

  useLayoutEffect(() => {
    refreshRetryActivatedRef.current = false;
  }, [action]);

  useLayoutEffect(() => {
    if (!pending && restoreConfirmFocus) {
      confirmButtonRef.current?.focus();
      setRestoreConfirmFocus(false);
    }
  }, [pending, restoreConfirmFocus]);

  useLayoutEffect(() => {
    if (action && !refreshRetryVisible && refreshRetryActivatedRef.current) {
      confirmButtonRef.current?.focus();
      refreshRetryActivatedRef.current = false;
    }
  }, [action, refreshRetryVisible]);

  if (!action) {
    return null;
  }

  const isCancel = action.kind === "cancel";
  const trimmedReason = reservationReason.trim();
  const confirmDisabled = pending || (isCancel ? !cancelConfirmed : trimmedReason.length === 0);

  const handleClose = (): void => {
    if (!pending) {
      onClose();
    }
  };

  const handleConfirm = async (): Promise<void> => {
    if (confirmingRef.current || confirmDisabled) {
      return;
    }
    confirmingRef.current = true;
    setConfirming(true);
    const outcome = await onConfirm(isCancel ? { kind: "cancel" } : { kind: "reserve", reason: trimmedReason });
    switch (outcome.kind) {
      case "error":
        confirmingRef.current = false;
        setConfirming(false);
        setRestoreConfirmFocus(true);
        return;
      case "success":
        return;
    }
  };

  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <section
        aria-busy={pending}
        aria-describedby="reservation-confirm-description"
        aria-labelledby="reservation-confirm-title"
        aria-modal="true"
        className="confirm-dialog"
        data-kind={action.kind}
        ref={dialogRef}
        role="dialog"
      >
        <button
          aria-label="확인 창 닫기"
          className="icon-button confirm-close"
          disabled={pending}
          type="button"
          onClick={handleClose}
        >
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
        {errorMessage ? <p className="confirm-policy-note" role="alert">{errorMessage}</p> : null}
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
                disabled={pending}
                ref={cancelConfirmationRef}
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
                disabled={pending}
                maxLength={80}
                placeholder="이용 사유를 직접 입력"
                ref={reasonRef}
                value={reservationReason}
                onChange={(event) => setReservationReason(event.currentTarget.value)}
              />
            </label>
            <p className="confirm-policy-note">미참석 시 정보실 예약이 영구 제한됩니다.</p>
          </div>
        )}
        <div className="confirm-actions">
          {onRefreshRetry ? (
            <button
              aria-busy={refreshRetrying}
              aria-label="다시 불러오기"
              className="ghost-button"
              disabled={pending || refreshRetrying}
              type="button"
              onClick={() => {
                refreshRetryActivatedRef.current = true;
                onRefreshRetry();
              }}
            >
              {refreshRetrying ? "다시 불러오는 중" : "다시 불러오기"}
            </button>
          ) : null}
          <button className="ghost-button" disabled={pending} type="button" onClick={handleClose}>
            닫기
          </button>
          <button
            aria-label={isCancel ? "취소 확정" : "신청하기"}
            className="primary-button danger-aware"
            disabled={confirmDisabled}
            ref={confirmButtonRef}
            type="button"
            onClick={() => void handleConfirm()}
          >
            {pending ? "처리 중" : isCancel ? "취소 확정" : "신청하기"}
          </button>
        </div>
      </section>
    </div>
  );
}
