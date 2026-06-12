"use client";

import { CalendarClock, LogOut, Save } from "lucide-react";

import type { AdminPeriodSetting, StudyPeriod } from "./admin-types";

export function AdminSettingsPanel({
  date,
  onLogout,
  onDateChange,
  onSave,
  onUpdatePeriod,
  periods
}: {
  readonly date: string;
  readonly onLogout: () => void;
  readonly onDateChange: (date: string) => void;
  readonly onSave: () => void;
  readonly onUpdatePeriod: (studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>) => void;
  readonly periods: readonly AdminPeriodSetting[];
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="brand-row">
        <span className="brand-mark">
          <CalendarClock size={22} />
        </span>
        <button className="ghost-button" type="button" onClick={onLogout}>
          <LogOut size={18} />
          로그아웃
        </button>
      </div>
      <div>
        <h1>관리자</h1>
        <p className="muted">시간 설정 · 운영 현황 · 학생 관리</p>
      </div>
      <label className="field">
        <span>예약 날짜</span>
        <input type="date" value={date} onChange={(event) => onDateChange(event.currentTarget.value)} />
      </label>
      <div className="stack">
        {periods.map((period) => (
          <div className="period-card" key={period.studyPeriod}>
            <div className="period-top">
              <h3>{period.label}</h3>
              <label className="row">
                <span className="muted">사용</span>
                <input
                  checked={period.enabled}
                  type="checkbox"
                  onChange={(event) => onUpdatePeriod(period.studyPeriod, { enabled: event.currentTarget.checked })}
                />
              </label>
            </div>
            <div className="admin-row">
              <label className="field">
                <span>오픈</span>
                <input value={period.openTime} onChange={(event) => onUpdatePeriod(period.studyPeriod, { openTime: event.currentTarget.value })} />
              </label>
              <label className="field">
                <span>마감</span>
                <input value={period.closeTime} onChange={(event) => onUpdatePeriod(period.studyPeriod, { closeTime: event.currentTarget.value })} />
              </label>
              <label className="field">
                <span>정원</span>
                <input
                  min={1}
                  type="number"
                  value={period.capacity}
                  onChange={(event) => onUpdatePeriod(period.studyPeriod, { capacity: Number(event.currentTarget.value) })}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
      <button className="primary-button" type="button" onClick={onSave}>
        <Save size={18} />
        저장
      </button>
    </section>
  );
}
