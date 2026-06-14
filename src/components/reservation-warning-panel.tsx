import { Ban, CalendarX } from "lucide-react";
import type { ReactElement } from "react";

export function ReservationWarningPanel(): ReactElement {
  return (
    <section className="reservation-warning" aria-label="예약 주의사항">
      <p>
        <Ban size={16} />
        <span>신청 후 미참석 시 정보실 예약이 영구 제한됩니다.</span>
      </p>
      <p>
        <CalendarX size={16} />
        <span>예약 취소 시 3일간 예약이 제한됩니다.</span>
      </p>
    </section>
  );
}
