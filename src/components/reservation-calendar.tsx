"use client";

import { CalendarCheck } from "lucide-react";
import type { ReactElement } from "react";

import type { AdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { buildReservationCalendarDays, type ReservationCalendarDay } from "@/lib/reservation-calendar";

type ReservationCalendarProps = {
  readonly advancePolicy: AdvanceReservationPolicy;
  readonly selectedDate: string;
  readonly onSelectDate: (date: string) => void;
  readonly onTodayClick: () => void;
};

export function ReservationCalendar({
  advancePolicy,
  onSelectDate,
  onTodayClick,
  selectedDate
}: ReservationCalendarProps): ReactElement {
  const days = buildReservationCalendarDays(advancePolicy);

  return (
    <section aria-labelledby="reservation-calendar-title" className="reservation-calendar">
      <div className="calendar-head">
        <div>
          <h3 id="reservation-calendar-title">이번 주 예약</h3>
        </div>
        <button className="ghost-button calendar-today-button" type="button" onClick={onTodayClick}>
          <CalendarCheck aria-hidden="true" size={16} />
          오늘 예약
        </button>
      </div>
      <div className="calendar-grid">
        {days.map((day) => {
          const selected = selectedDate === day.date;
          return (
            <button
              aria-label={calendarDayLabel(day, selected)}
              aria-current={day.isToday ? "date" : undefined}
              aria-pressed={selected}
              className="calendar-day"
              data-advance={day.isAdvanceWindow}
              data-selected={selected}
              data-today={day.isToday}
              disabled={!day.selectable}
              key={day.date}
              type="button"
              onClick={() => onSelectDate(day.date)}
            >
              <span className="calendar-weekday">{day.dayLabel}</span>
              <strong>{formatCalendarDate(day.date)}</strong>
              {selected ? <span className="calendar-selection-label">선택</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function formatCalendarDate(date: string): string {
  return date.slice(5).replace("-", ".");
}

function calendarDayLabel(day: ReservationCalendarDay, selected: boolean): string {
  const parts = [`${day.dayLabel}요일 ${formatCalendarDate(day.date)}`];
  if (day.isToday) {
    parts.push("오늘");
  }
  if (selected) {
    parts.push("현황 보는 중");
  } else if (day.selectable) {
    parts.push("현황 확인 가능");
  } else {
    parts.push(day.isPast ? "지난 날짜" : "예약 기간 아님");
  }
  return parts.join(", ");
}
