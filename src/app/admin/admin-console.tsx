"use client";

import { AdminDashboardPanel } from "./admin-dashboard-panel";
import { AdminReservationsPanel } from "./admin-reservations-panel";
import { AdminSettingsPanel } from "./admin-settings-panel";
import { AdminUsersPanel } from "./admin-users-panel";
import { useAdminConsole } from "./use-admin-console";

export function AdminConsole(): React.ReactElement {
  const consoleState = useAdminConsole();
  return (
    <main className="app-shell">
      <div className="admin-grid">
        <AdminSettingsPanel
          date={consoleState.date}
          periods={consoleState.periods}
          onDateChange={consoleState.setDate}
          onSave={() => void consoleState.saveSettings()}
          onUpdatePeriod={consoleState.updatePeriod}
        />
        <div className="admin-content">
          <AdminDashboardPanel
            periods={consoleState.dashboardPeriods}
            onSendNotification={(period, force) => void consoleState.sendNotification(period, force)}
          />
          <AdminReservationsPanel
            reservations={consoleState.reservations}
            statusFilter={consoleState.statusFilter}
            onMarkNoShow={(reservationId) => void consoleState.markNoShow(reservationId)}
            onRefresh={() => void consoleState.refresh()}
            onSelectStatus={consoleState.selectStatus}
          />
          <AdminUsersPanel
            query={consoleState.userQuery}
            restrictionDrafts={consoleState.restrictionDrafts}
            status={consoleState.userStatusFilter}
            users={consoleState.users}
            onApplyRestriction={(userId) => void consoleState.applyRestriction(userId)}
            onRemoveRestriction={(userId) => void consoleState.removeRestriction(userId)}
            onSetDraft={consoleState.setRestrictionDraft}
            onSetQuery={consoleState.setUserQuery}
            onSetStatus={consoleState.setUserStatusFilter}
          />
          {consoleState.toast ? <div className="toast">{consoleState.toast}</div> : null}
        </div>
      </div>
    </main>
  );
}
