"use client";

import { Bell, Save } from "lucide-react";

import type { AdminNotificationSettings, AdminPeriodSetting, StudyPeriod } from "./admin-types";

export function AdminSettingsPanel({
  notificationSettings,
  onSave,
  onUpdateNotificationSettings,
  onUpdatePeriod,
  periods
}: {
  readonly notificationSettings: AdminNotificationSettings;
  readonly onSave: () => void;
  readonly onUpdateNotificationSettings: (patch: Partial<AdminNotificationSettings>) => void;
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
      <div className="notification-settings-block">
        <div className="period-top">
          <h3>
            <Bell aria-hidden="true" size={18} />
            디스코드 알림
          </h3>
        </div>
        <div className="notification-toggle-grid">
          <label className="notification-toggle">
            <span>마감 명단</span>
            <input
              checked={notificationSettings.closedPeriodNotificationsEnabled}
              type="checkbox"
              onChange={(event) =>
                onUpdateNotificationSettings({ closedPeriodNotificationsEnabled: event.currentTarget.checked })
              }
            />
          </label>
          <label className="notification-toggle">
            <span>신청 알림</span>
            <input
              checked={notificationSettings.reservationCreatedNotificationsEnabled}
              type="checkbox"
              onChange={(event) =>
                onUpdateNotificationSettings({ reservationCreatedNotificationsEnabled: event.currentTarget.checked })
              }
            />
          </label>
        </div>
      </div>
      <button className="primary-button" type="button" onClick={onSave}>
        <Save size={18} />
        저장
      </button>
    </section>
  );
}
