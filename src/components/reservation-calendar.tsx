"use client";

import { CalendarCheck } from "lucide-react";
import type { ReactElement } from "react";

import type { AdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import {
  buildReservationCalendarDays,
  summarizeReservationCalendarDay
} from "@/lib/reservation-calendar";
import type { PeriodSummary } from "./reservation-period-card";

type ReservationCalendarProps = {
  readonly advancePolicy: AdvanceReservationPolicy;
  readonly periodsByDate: {
    readonly [date: string]: readonly PeriodSummary[] | undefined;
  };
  readonly selectedDate: string;
  readonly onSelectDate: (date: string) => void;
  readonly onTodayClick: () => void;
};

export function ReservationCalendar({
  advancePolicy,
  onSelectDate,
  onTodayClick,
  periodsByDate,
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
          const summary = summarizeReservationCalendarDay(day, periodsByDate[day.date]);
          return (
            <button
              aria-current={day.isToday ? "date" : undefined}
              aria-pressed={selectedDate === day.date}
              className="calendar-day"
              data-advance={day.isAdvanceWindow}
              data-selected={selectedDate === day.date}
              data-status={summary.status}
              data-today={day.isToday}
              disabled={!day.selectable}
              key={day.date}
              type="button"
              onClick={() => onSelectDate(day.date)}
            >
              <span className="calendar-weekday">{day.dayLabel}</span>
              <strong>{formatCalendarDate(day.date)}</strong>
              <span className="calendar-status">{summary.statusLabel}</span>
              <span className="calendar-detail">{summary.detail}</span>
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
