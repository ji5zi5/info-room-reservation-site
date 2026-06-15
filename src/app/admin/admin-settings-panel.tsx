"use client";

import { Save } from "lucide-react";

import type { AdminPeriodSetting, StudyPeriod } from "./admin-types";

export function AdminSettingsPanel({
  onSave,
  onUpdatePeriod,
  periods
}: {
  readonly onSave: () => void;
  readonly onUpdatePeriod: (studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>) => void;
  readonly periods: readonly AdminPeriodSetting[];
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <h2>시간 설정</h2>
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
                <input
                  step={60}
                  type="time"
                  value={period.openTime}
                  onChange={(event) => onUpdatePeriod(period.studyPeriod, { openTime: event.currentTarget.value })}
                />
              </label>
              <label className="field">
                <span>마감</span>
                <input
                  step={60}
                  type="time"
                  value={period.closeTime}
                  onChange={(event) => onUpdatePeriod(period.studyPeriod, { closeTime: event.currentTarget.value })}
                />
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
