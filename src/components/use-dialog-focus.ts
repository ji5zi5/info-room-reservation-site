"use client";

import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type DialogFocusInput = {
  readonly canDismiss: boolean;
  readonly dialogRef: RefObject<HTMLElement | null>;
  readonly initialFocusKey: string;
  readonly initialFocusRef: RefObject<HTMLElement | null>;
  readonly onDismiss: () => void;
  readonly open: boolean;
};

export function useDialogFocus(input: DialogFocusInput): void {
  const canDismissRef = useRef(input.canDismiss);
  const onDismissRef = useRef(input.onDismiss);
  canDismissRef.current = input.canDismiss;
  onDismissRef.current = input.onDismiss;

  useLayoutEffect(() => {
    if (!input.open) {
      return;
    }

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = input.dialogRef.current;
    if (!dialog) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (canDismissRef.current) {
          onDismissRef.current();
        }
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.isConnected && element.getAttribute("aria-hidden") !== "true"
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement;
      if (!dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (opener?.isConnected) {
        opener.focus();
      }
    };
  }, [input.dialogRef, input.open]);

  useLayoutEffect(() => {
    if (!input.open) {
      return;
    }
    const initialFocus = input.initialFocusRef.current;
    if (initialFocus?.isConnected) {
      initialFocus.focus();
    }
  }, [input.initialFocusKey, input.initialFocusRef, input.open]);
}
