"use client";

import { BarChart3, CalendarClock, ListChecks, LogOut, Search, Settings, ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";

import { AdminAuditPanel } from "./admin-audit-panel";
import { AdminDashboardPanel } from "./admin-dashboard-panel";
import { AdminReservationsPanel } from "./admin-reservations-panel";
import { AdminSettingsPanel } from "./admin-settings-panel";
import { AdminStudentDetail } from "./admin-student-detail";
import { AdminUsersPanel } from "./admin-users-panel";
import { csrfFetch, resetCsrfToken } from "../csrf-fetch";
import { type AdminSection, useAdminConsole } from "./use-admin-console";

const SECTION_LABELS: Record<AdminSection, string> = {
  audit: "감사",
  dashboard: "운영",
  reservations: "예약자",
  settings: "설정",
  students: "학생"
};

const SECTIONS: readonly {
  readonly icon: ReactElement;
  readonly id: AdminSection;
}[] = [
  { icon: <BarChart3 size={18} />, id: "dashboard" },
  { icon: <ListChecks size={18} />, id: "reservations" },
  { icon: <Search size={18} />, id: "students" },
  { icon: <ShieldAlert size={18} />, id: "audit" },
  { icon: <Settings size={18} />, id: "settings" }
];

export function AdminConsole(): ReactElement {
  const consoleState = useAdminConsole();

  async function logout(): Promise<void> {
    await csrfFetch("/api/auth/logout", { method: "POST" });
    resetCsrfToken();
    window.location.assign("/");
  }

  return (
    <main className="app-shell admin-shell">
      <div className="admin-console-layout">
        <aside className="admin-nav-panel">
          <div className="brand-row">
            <span className="brand-mark">
              <CalendarClock size={22} />
            </span>
            <strong>정보실 운영</strong>
          </div>
          <div className="admin-title-block">
            <h1>관리자</h1>
            <p className="muted">현황 · 명단 · 학생 제재 · 설정</p>
          </div>
          <nav className="admin-section-nav" aria-label="관리자 메뉴">
            {SECTIONS.map((section) => (
              <button
                data-active={consoleState.activeSection === section.id}
                key={section.id}
                type="button"
                onClick={() => consoleState.setActiveSection(section.id)}
              >
                {section.icon}
                {SECTION_LABELS[section.id]}
              </button>
            ))}
          </nav>
          <label className="field admin-date-picker">
            <span>운영 날짜</span>
            <input type="date" value={consoleState.date} onChange={(event) => consoleState.setDate(event.currentTarget.value)} />
          </label>
          <button className="ghost-button" type="button" onClick={() => void logout()}>
            <LogOut size={18} />
            로그아웃
          </button>
        </aside>
        <div className="admin-workspace">
          <section className="admin-main-panel" aria-live="polite">
            {consoleState.activeSection === "dashboard" ? (
              <AdminDashboardPanel
                periods={consoleState.dashboardPeriods}
                statistics={consoleState.statistics}
                onSendNotification={(period, force) => void consoleState.sendNotification(period, force)}
              />
            ) : null}
            {consoleState.activeSection === "reservations" ? (
              <AdminReservationsPanel
                periodFilter={consoleState.reservationPeriodFilter}
                query={consoleState.reservationQuery}
                reservations={consoleState.reservations}
                statusFilter={consoleState.statusFilter}
                onCancelReservation={(reservationId) => void consoleState.cancelReservation(reservationId)}
                onCopyCsv={() => void consoleState.copyReservationsCsv()}
                onMarkNoShow={(reservationId) => void consoleState.markNoShow(reservationId)}
                onRefresh={() => void consoleState.refresh()}
                onSelectStatus={consoleState.selectStatus}
                onSetPeriod={consoleState.setReservationPeriodFilter}
                onSetQuery={consoleState.setReservationQuery}
                onViewUser={(userId) => void consoleState.viewUser(userId)}
              />
            ) : null}
            {consoleState.activeSection === "students" ? (
              <AdminUsersPanel
                query={consoleState.userQuery}
                restrictionDrafts={consoleState.restrictionDrafts}
                selectedUserId={consoleState.selectedUserId}
                status={consoleState.userStatusFilter}
                users={consoleState.users}
                onApplyRestriction={(userId) => void consoleState.applyRestriction(userId)}
                onRemoveRestriction={(userId) => void consoleState.removeRestriction(userId)}
                onSelectUser={(userId) => void consoleState.viewUser(userId)}
                onSetDraft={consoleState.setRestrictionDraft}
                onSetQuery={consoleState.setUserQuery}
                onSetStatus={consoleState.setUserStatusFilter}
              />
            ) : null}
            {consoleState.activeSection === "audit" ? (
              <AdminAuditPanel
                actionFilter={consoleState.auditActionFilter}
                actions={consoleState.auditActions}
                query={consoleState.auditQuery}
                onSetActionFilter={consoleState.setAuditActionFilter}
                onSetQuery={consoleState.setAuditQuery}
                onViewUser={(userId) => void consoleState.viewUser(userId)}
              />
            ) : null}
            {consoleState.activeSection === "settings" ? (
              <AdminSettingsPanel
                date={consoleState.date}
                periods={consoleState.periods}
                onDateChange={consoleState.setDate}
                onLogout={() => void logout()}
                onSave={() => void consoleState.saveSettings()}
                onUpdatePeriod={consoleState.updatePeriod}
              />
            ) : null}
          </section>
          <AdminStudentDetail
            detail={consoleState.selectedUserDetail}
            onApplyPreset={(userId, days) => void consoleState.applyRestrictionPreset(userId, days)}
            onBan={(userId) => void consoleState.banUser(userId)}
            onClose={consoleState.clearSelectedUser}
            onRelease={(userId) => void consoleState.removeRestriction(userId)}
            onRevokeSessions={(userId) => void consoleState.revokeSessions(userId)}
          />
          {consoleState.toast ? <div className="toast admin-toast">{consoleState.toast}</div> : null}
        </div>
      </div>
    </main>
  );
}
