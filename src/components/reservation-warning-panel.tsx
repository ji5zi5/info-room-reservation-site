import { Ban, CalendarX } from "lucide-react";
import type { ReactElement } from "react";

export function ReservationWarningPanel(): ReactElement {
  return (
    <section className="reservation-warning" aria-label="예약 규칙">
      <strong>예약 규칙</strong>
      <span>
        <Ban size={16} />
        미참석 시 영구 제한
      </span>
      <span>
        <CalendarX size={16} />
        취소 시 3일 제한
      </span>
    </section>
  );
}
