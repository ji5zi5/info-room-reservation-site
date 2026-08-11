"use client";

import { X } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";

import type { AdminMutationResult } from "./admin-api-client";
import { mutationErrorMessage } from "./admin-settings-save-result";
import { useDialogFocus } from "@/components/use-dialog-focus";

type AdminConfirmationDialogProps = {
  readonly cancelLabel: string;
  readonly children?: ReactNode;
  readonly confirmDisabled?: boolean;
  readonly confirmLabel: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly onConfirm: () => Promise<AdminMutationResult<unknown>>;
  readonly onDismiss: () => void;
  readonly title: string;
};

export function AdminConfirmationDialog({
  cancelLabel,
  children,
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
    if (submitLockRef.current) {
      return;
    }
    submitLockRef.current = true;
    setPending(true);
    setErrorMessage(null);
    try {
      const result = await onConfirm();
      if (result.kind === "ok") {
        onDismiss();
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
          <button className="danger-button" disabled={pending || confirmDisabled} type="button" onClick={() => void submit()}>
            {pending ? "처리 중…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
