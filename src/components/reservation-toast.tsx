"use client";

import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import type { ReactElement } from "react";

type ReservationToastProps = {
  readonly message: string | null;
};

type ToastTone = "danger" | "info" | "success";

export function ReservationToast({ message }: ReservationToastProps): ReactElement | null {
  if (!message) {
    return null;
  }

  const tone = resolveTone(message);
  return (
    <div
      aria-live={tone === "danger" ? "assertive" : "polite"}
      className="toast student-toast"
      data-tone={tone}
      role={tone === "danger" ? "alert" : "status"}
    >
      {toastIcon(tone)}
      <span>{message}</span>
    </div>
  );
}

function resolveTone(message: string): ToastTone {
  if (message.includes("실패") || message.includes("제한") || message.includes("마감") || message.includes("필요")) {
    return "danger";
  }
  if (message.includes("확정") || message.includes("완료") || message.includes("준비") || message.includes("로그아웃")) {
    return "success";
  }
  return "info";
}

function toastIcon(tone: ToastTone): ReactElement {
  switch (tone) {
    case "danger":
      return <AlertCircle size={18} />;
    case "success":
      return <CheckCircle2 size={18} />;
    case "info":
      return <Info size={18} />;
  }
}
