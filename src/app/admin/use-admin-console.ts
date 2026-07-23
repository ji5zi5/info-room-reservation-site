"use client";

import { useEffect, useState } from "react";

import {
  applyUserRestriction,
  cancelAdminReservation,
  markReservationNoShow,
  reconcileClosedPeriodNotification,
  removeUserRestriction,
  saveAdminNotificationSettings,
  saveAdminSettings,
  sendClosedPeriodNotification,
  updatePeriodSetting
} from "./admin-api-client";
import { todayKst } from "./admin-date";
import { buildReservationCsv } from "./admin-csv";
import { adminSettingsSaveMessage } from "./admin-settings-save-result";
import { readReservationStatusFromLocation, writeReservationStatusToHistory } from "./admin-console-url";
import { patchRestrictionDrafts } from "./admin-restriction-drafts";
import {
  DEFAULT_RESTRICTION_DRAFT,
  type AdminConsoleState,
  type AdminSection,
  type UserRestrictionDraft
} from "./admin-console-state";
import {
  type AdminAuditActionFilter,
  type AdminDashboardPeriod,
  type AdminNotificationBacklogItem,
  type AdminNotificationReconciliationAction,
  type AdminNotificationSettings,
  type AdminPeriodSetting,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter,
  type AdminUserStatusFilter,
  type StudyPeriod
} from "./admin-types";
import { useAdminConsoleReads } from "./use-admin-console-reads";

const SHADOW_BAN_RESTRICTION = { days: null, reason: "블랙리스트", shadowBanProfile: "NORMAL", status: "SHADOW_BANNED" } as const;

export function useAdminConsole(): AdminConsoleState {
  const [activeSection, setActiveSection] = useState<AdminSection>("dashboard");
  const [date, setDate] = useState(todayKst());
  const [auditActionFilter, setAuditActionFilter] = useState<AdminAuditActionFilter>("ALL");
  const [auditQuery, setAuditQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AdminReservationStatusFilter>("CONFIRMED");
  const [reservationPeriodFilter, setReservationPeriodFilter] = useState<AdminReservationStudyPeriodFilter>("ALL");
  const [reservationQuery, setReservationQuery] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<AdminUserStatusFilter>("ALL");
  const [userQuery, setUserQuery] = useState("");
  const [restrictionDrafts, setRestrictionDrafts] = useState<Readonly<Record<string, UserRestrictionDraft>>>({});
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const reads = useAdminConsoleReads({
    activeSection,
    auditActionFilter,
    auditQuery,
    date,
    reservationPeriodFilter,
    reservationQuery,
    selectedUserId,
    statusFilter,
    userQuery,
    userStatusFilter
  });

  useEffect(() => {
    setStatusFilter(readReservationStatusFromLocation(window.location));
  }, []);

  async function refresh(): Promise<void> {
    if (activeSection === "settings") {
      reads.refreshShared();
      return;
    }
    reads.refreshActive();
  }

  async function saveSettings(): Promise<void> {
    const [periodsOk, notificationsOk] = await Promise.all([
      saveAdminSettings({ date, periods: reads.periods }),
      saveAdminNotificationSettings(reads.notificationSettings)
    ]);
    setToast(adminSettingsSaveMessage({ notificationsSaved: notificationsOk, periodsSaved: periodsOk }));
    reads.refreshShared();
  }

  async function sendNotification(period: AdminDashboardPeriod): Promise<void> {
    const ok = await sendClosedPeriodNotification(period);
    setToast(ok ? "마감 명단을 전송했습니다." : "마감 명단 전송에 실패했습니다.");
    reads.refreshActive();
  }

  async function reconcileNotification(
    item: AdminNotificationBacklogItem,
    action: AdminNotificationReconciliationAction
  ): Promise<void> {
    const ok = await reconcileClosedPeriodNotification(item, action);
    setToast(ok ? reconciliationSuccessMessage(action) : "알림 상태 조정에 실패했습니다.");
    reads.refreshActive();
  }

  async function markNoShow(reservationId: string): Promise<void> {
    const ok = await markReservationNoShow(reservationId);
    setToast(ok ? "노쇼 처리와 영구 차단을 적용했습니다." : "노쇼 처리 실패");
    reads.refreshActive();
  }

  async function cancelReservation(reservationId: string, reason: string): Promise<void> {
    const ok = await cancelAdminReservation(reservationId, reason);
    setToast(ok ? "예약을 관리자 취소 처리했습니다." : "예약 취소 실패");
    reads.refreshActive();
  }

  async function removeRestriction(userId: string): Promise<void> {
    const ok = await removeUserRestriction(userId);
    setToast(ok ? "예약 제한을 해제했습니다." : "제한 해제 실패");
    reads.refreshActive();
  }

  async function applyRestriction(userId: string): Promise<void> {
    const draft = restrictionDrafts[userId] ?? DEFAULT_RESTRICTION_DRAFT;
    const reason = draft.reason.trim();
    if (!reason) {
      setToast("제재 사유를 입력하세요.");
      return;
    }
    const parsedDays = Number.parseInt(draft.days, 10);
    const ok = await applyUserRestriction(userId, {
      days: draft.status === "RESTRICTED" ? Math.max(parsedDays || 7, 1) : null,
      reason,
      shadowBanProfile: draft.shadowBanProfile,
      status: draft.status
    });
    setToast(ok ? "학생 제재를 적용했습니다." : "학생 제재 적용 실패");
    reads.refreshActive();
  }

  async function applyShadowBan(userId: string): Promise<void> {
    const ok = await applyUserRestriction(userId, SHADOW_BAN_RESTRICTION);
    setToast(ok ? "블랙리스트에 추가했습니다." : "블랙리스트 추가 실패");
    reads.refreshActive();
  }

  function updatePeriod(studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>): void {
    reads.setPeriods((current) => updatePeriodSetting(current, studyPeriod, patch));
  }

  function updateNotificationSettings(patch: Partial<AdminNotificationSettings>): void {
    reads.setNotificationSettings((current) => ({ ...current, ...patch, id: "global" }));
  }

  function selectStatus(nextStatus: AdminReservationStatusFilter): void {
    setStatusFilter(nextStatus);
    writeReservationStatusToHistory(window.location, window.history, nextStatus);
  }

  async function viewUser(userId: string): Promise<void> {
    setSelectedUserId(userId);
    setActiveSection("students");
  }

  function clearSelectedUser(): void {
    setSelectedUserId(null);
    reads.clearSelectedUserDetail();
  }

  async function copyReservationsCsv(): Promise<void> {
    await navigator.clipboard.writeText(buildReservationCsv(reads.reservations));
    setToast("현재 예약 목록을 복사했습니다.");
  }

  function setRestrictionDraft(userId: string, patch: Partial<UserRestrictionDraft>): void {
    setRestrictionDrafts((current) => patchRestrictionDrafts(current, userId, patch));
  }

  return {
    activeSection,
    auditActionFilter,
    auditActions: reads.auditActions,
    auditQuery,
    applyRestriction,
    applyShadowBan,
    cancelReservation,
    clearSelectedUser,
    copyReservationsCsv,
    dashboardPeriods: reads.dashboardPeriods,
    date,
    markNoShow,
    notificationBacklog: reads.notificationBacklog,
    notificationSettings: reads.notificationSettings,
    periods: reads.periods,
    refresh,
    reconcileNotification,
    removeRestriction,
    reservationPeriodFilter,
    reservationQuery,
    reservations: reads.reservations,
    restrictionDrafts,
    saveSettings,
    selectedUserDetail: reads.selectedUserDetail,
    selectedUserId,
    selectStatus,
    sendNotification,
    setActiveSection,
    setAuditActionFilter,
    setAuditQuery,
    setDate,
    setReservationPeriodFilter,
    setReservationQuery,
    setRestrictionDraft,
    setUserQuery,
    setUserStatusFilter,
    statusFilter,
    statistics: reads.statistics,
    toast: reads.error ?? toast,
    updateNotificationSettings,
    updatePeriod,
    userQuery,
    userStatusFilter,
    users: reads.users,
    viewUser
  };
}

function reconciliationSuccessMessage(action: AdminNotificationReconciliationAction): string {
  switch (action) {
    case "abandon":
      return "알림 확인을 종료했습니다.";
    case "confirm_sent":
      return "전송 완료로 처리했습니다.";
    case "retry":
      return "마감 명단을 다시 전송했습니다.";
  }
}
