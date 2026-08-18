"use client";

import { X } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

import type { AdminMutationResult } from "./admin-api-client";
import type {
  BulkCancellationData,
  BulkCancellationInput
} from "./admin-api-client";
import type { AdminReservation } from "./admin-types";
import { mutationErrorMessage } from "./admin-settings-save-result";
import { useDialogFocus } from "@/components/use-dialog-focus";

type AdminConfirmationDialogProps = {
  readonly cancelLabel: string;
  readonly children?: ReactNode;
  readonly closeOnSuccess?: boolean;
  readonly confirmDisabled?: boolean;
  readonly confirmLabel?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly onConfirm?: () => Promise<AdminMutationResult<unknown>>;
  readonly onDismiss: () => void;
  readonly title: string;
};

export function AdminConfirmationDialog({
  cancelLabel,
  children,
  closeOnSuccess = true,
  confirmDisabled = false,
  confirmLabel,
  initialFocusRef,
  onConfirm,
  onDismiss,
  title
}: AdminConfirmationDialogProps): ReactElement {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const fallbackFocusRef = useRef<HTMLButtonElement>(null);
  const submitLockRef = useRef(false);
  const effectiveInitialFocusRef = initialFocusRef ?? fallbackFocusRef;

  useDialogFocus({
    canDismiss: !pending,
    dialogRef,
    initialFocusKey: `${pending}:${title}`,
    initialFocusRef: effectiveInitialFocusRef,
    onDismiss,
    open: true
  });

  async function submit(): Promise<void> {
    if (submitLockRef.current || !onConfirm) {
      return;
    }
    submitLockRef.current = true;
    setPending(true);
    setErrorMessage(null);
    try {
      const result = await onConfirm();
      if (result.kind === "ok") {
        if (closeOnSuccess) {
          onDismiss();
        }
        return;
      }
      setErrorMessage(mutationErrorMessage(result));
    } finally {
      submitLockRef.current = false;
      setPending(false);
    }
  }

  return (
    <div
      className="confirm-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!pending && event.currentTarget === event.target) {
          onDismiss();
        }
      }}
    >
      <section aria-labelledby="admin-confirmation-title" aria-modal="true" className="confirm-dialog" ref={dialogRef} role="dialog">
        <button
          aria-label="닫기"
          className="icon-button confirm-close"
          disabled={pending}
          type="button"
          onClick={() => {
            if (!pending) {
              onDismiss();
            }
          }}
        >
          <X aria-hidden="true" size={18} />
        </button>
        <div>
          <h3 id="admin-confirmation-title">{title}</h3>
        </div>
        {children}
        {errorMessage ? <p className="muted" role="alert">{errorMessage}</p> : null}
        <div className="admin-dialog-actions">
          <button
            className="ghost-button"
            disabled={pending}
            ref={fallbackFocusRef}
            type="button"
            onClick={() => {
              if (!pending) {
                onDismiss();
              }
            }}
          >
            {cancelLabel}
          </button>
          {onConfirm && confirmLabel ? (
            <button className="danger-button" disabled={pending || confirmDisabled} type="button" onClick={() => void submit()}>
              {pending ? "처리 중…" : confirmLabel}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function AdminBulkCancellationDialog({
  onDismiss,
  onMutate,
  onExecuted,
  reservations
}: {
  readonly onDismiss: () => void;
  readonly onMutate: (input: BulkCancellationInput) => Promise<AdminMutationResult<BulkCancellationData>>;
  readonly onExecuted: (result: BulkCancellationData) => void;
  readonly reservations: readonly AdminReservation[];
}): ReactElement {
  const [preview, setPreview] = useState<BulkCancellationData | null>(null);
  const [executionResult, setExecutionResult] = useState<BulkCancellationData | null>(null);
  const [reason, setReason] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const initialReservationsRef = useRef(reservations);
  const trimmedReason = reason.trim();
  const selectedReservations = initialReservationsRef.current;
  const reservationIds = selectedReservations.map((reservation) => reservation.id);

  async function mutate(mode: BulkCancellationInput["mode"]): Promise<AdminMutationResult<BulkCancellationData>> {
    return onMutate({ mode, reason: trimmedReason, reservationIds });
  }

  async function requestPreview(): Promise<AdminMutationResult<BulkCancellationData>> {
    const result = await mutate("preview");
    if (result.kind === "ok") {
      setPreview(result.data);
    }
    return result;
  }

  async function executeCancellation(): Promise<AdminMutationResult<BulkCancellationData>> {
    const result = await mutate("execute");
    if (result.kind === "ok") {
      setExecutionResult(result.data);
      onExecuted(result.data);
    }
    return result;
  }

  if (preview === null) {
    return (
      <AdminConfirmationDialog
        cancelLabel="닫기"
        closeOnSuccess={false}
        confirmDisabled={!trimmedReason}
        confirmLabel="서버 미리보기"
        initialFocusRef={reasonRef}
        onConfirm={requestPreview}
        onDismiss={onDismiss}
        title="일괄 취소 미리보기"
      >
        <p className="muted">선택한 예약의 현재 상태를 서버에서 다시 확인합니다.</p>
        <label className="field">
          <span>취소 사유</span>
          <textarea
            maxLength={200}
            ref={reasonRef}
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
      </AdminConfirmationDialog>
    );
  }

  if (executionResult !== null) {
    return (
      <AdminConfirmationDialog
        cancelLabel="확인"
        onDismiss={onDismiss}
        title="일괄 취소 결과"
      >
        <BulkCancellationSummary cancellationLabel="취소 완료" result={executionResult} title="처리 완료" />
        <BulkCancellationResultList
          mode="result"
          reservations={selectedReservations}
          result={executionResult}
        />
      </AdminConfirmationDialog>
    );
  }

  return (
    <AdminConfirmationDialog
      cancelLabel="돌아가기"
      closeOnSuccess={false}
      confirmLabel="일괄 취소 확정"
      onConfirm={executeCancellation}
      onDismiss={onDismiss}
      title="선택 예약을 취소할까요?"
    >
      <BulkCancellationSummary cancellationLabel="취소 가능" result={preview} title="확인" />
      <BulkCancellationResultList mode="preview" reservations={selectedReservations} result={preview} />
      <p className="muted">취소 사유: {trimmedReason}</p>
    </AdminConfirmationDialog>
  );
}

function BulkCancellationSummary({
  cancellationLabel,
  result,
  title
}: {
  readonly cancellationLabel: string;
  readonly result: BulkCancellationData;
  readonly title: string;
}): ReactElement {
  return (
    <div className="bulk-cancellation-summary" aria-label={`일괄 취소 ${title} 결과`}>
      <strong>{result.summary.total}건 {title}</strong>
      <span>{cancellationLabel} {result.summary.cancelled}건</span>
      <span>상태 변경 {result.summary.invalidStatus}건</span>
      <span>찾을 수 없음 {result.summary.notFound}건</span>
      <span>재시도 필요 {result.summary.conflict}건</span>
    </div>
  );
}

function BulkCancellationResultList({
  mode,
  reservations,
  result
}: {
  readonly mode: "preview" | "result";
  readonly reservations: readonly AdminReservation[];
  readonly result: BulkCancellationData;
}): ReactElement {
  return (
    <div className="bulk-cancellation-preview-list">
      {result.results.map((item) => {
        const reservation = reservations.find((candidate) => candidate.id === item.reservationId);
        return (
          <div className="bulk-cancellation-preview-row" data-status={item.status} key={item.reservationId}>
            <div>
              <strong>{reservation?.user.name ?? "선택한 예약"}</strong>
              <span className="muted">
                {reservation ? `${reservation.date} ${studyPeriodLabel(reservation.studyPeriod)}` : item.reservationId}
              </span>
            </div>
            <span>{bulkCancellationStatusLabel(item.status, mode)}</span>
          </div>
        );
      })}
    </div>
  );
}

function bulkCancellationStatusLabel(
  status: BulkCancellationData["results"][number]["status"],
  mode: "preview" | "result"
): string {
  switch (status) {
    case "cancelled": return mode === "preview" ? "취소 가능" : "취소 완료";
    case "conflict": return mode === "preview" ? "재확인 필요" : "재시도 필요";
    case "invalid_status": return "상태 변경";
    case "not_found": return "찾을 수 없음";
  }
}

function studyPeriodLabel(studyPeriod: string): string {
  return studyPeriod === "EIGHTH" ? "8면학" : "1면학";
}
