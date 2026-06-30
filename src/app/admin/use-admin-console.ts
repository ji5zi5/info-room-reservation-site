"use client";

import { useEffect, useState } from "react";

import {
  applyUserRestriction,
  cancelAdminReservation,
  fetchAdminAuditActions,
  fetchAdminDashboard,
  fetchAdminNotificationSettings,
  fetchAdminReservations,
  fetchAdminSettings,
  fetchAdminStatistics,
  fetchAdminUserDetail,
  markReservationNoShow,
  removeUserRestriction,
  saveAdminNotificationSettings,
  saveAdminSettings,
  sendClosedPeriodNotification,
  updatePeriodSetting
} from "./admin-api-client";
import { todayKst } from "./admin-date";
import { buildReservationCsv } from "./admin-csv";
import { readReservationStatusFromLocation, writeReservationStatusToHistory } from "./admin-console-url";
import { firstAdminReadError } from "./admin-read-error";
import { patchRestrictionDrafts } from "./admin-restriction-drafts";
import { fetchAdminUsersForSection } from "./admin-user-fetching";
import {
  DEFAULT_RESTRICTION_DRAFT,
  type AdminConsoleState,
  type AdminSection,
  type UserRestrictionDraft
} from "./admin-console-state";
import {
  type AdminAuditAction,
  type AdminAuditActionFilter,
  type AdminDashboardPeriod,
  type AdminNotificationSettings,
  type AdminPeriodSetting,
  type AdminReservation,
  type AdminReservationStatusFilter,
  type AdminReservationStudyPeriodFilter,
  type AdminStatistics,
  type AdminUser,
  type AdminUserDetail,
  type AdminUserStatusFilter,
  type StudyPeriod
} from "./admin-types";

const SHADOW_BAN_RESTRICTION = { days: null, reason: "블랙리스트", status: "SHADOW_BANNED" } as const;

const DEFAULT_NOTIFICATION_SETTINGS = {
  closedPeriodNotificationsEnabled: true,
  id: "global",
  reservationCreatedNotificationsEnabled: false
} satisfies AdminNotificationSettings;

export function useAdminConsole(): AdminConsoleState {
  const [activeSection, setActiveSection] = useState<AdminSection>("dashboard");
  const [date, setDate] = useState(todayKst());
  const [periods, setPeriods] = useState<readonly AdminPeriodSetting[]>([]);
  const [notificationSettings, setNotificationSettings] =
    useState<AdminNotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [dashboardPeriods, setDashboardPeriods] = useState<readonly AdminDashboardPeriod[]>([]);
  const [reservations, setReservations] = useState<readonly AdminReservation[]>([]);
  const [statistics, setStatistics] = useState<AdminStatistics | null>(null);
  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [auditActions, setAuditActions] = useState<readonly AdminAuditAction[]>([]);
  const [auditActionFilter, setAuditActionFilter] = useState<AdminAuditActionFilter>("ALL");
  const [auditQuery, setAuditQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<AdminReservationStatusFilter>("CONFIRMED");
  const [reservationPeriodFilter, setReservationPeriodFilter] = useState<AdminReservationStudyPeriodFilter>("ALL");
  const [reservationQuery, setReservationQuery] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState<AdminUserStatusFilter>("ALL");
  const [userQuery, setUserQuery] = useState("");
  const [restrictionDrafts, setRestrictionDrafts] = useState<Readonly<Record<string, UserRestrictionDraft>>>({});
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedUserDetail, setSelectedUserDetail] = useState<AdminUserDetail | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setStatusFilter(readReservationStatusFromLocation(window.location));
  }, []);

  useEffect(() => {
    void refresh();
  }, [
    activeSection,
    auditActionFilter,
    auditQuery,
    date,
    reservationPeriodFilter,
    reservationQuery,
    statusFilter,
    userQuery,
    userStatusFilter
  ]);

  useEffect(() => {
    if (selectedUserId) {
      void refreshSelectedUser(selectedUserId);
    }
  }, [selectedUserId]);

  async function refresh(): Promise<void> {
    const [settingsPayload, notificationSettingsPayload] = await Promise.all([
      fetchAdminSettings(date),
      fetchAdminNotificationSettings()
    ]);
    if (settingsPayload.kind === "unauthorized") {
      setToast("관리자 로그인이 필요합니다.");
      return;
    }
    if (notificationSettingsPayload.kind === "unauthorized") {
      setToast("관리자 로그인이 필요합니다.");
      return;
    }
    if (settingsPayload.kind === "error") {
      setToast(settingsPayload.message);
      return;
    }
    if (notificationSettingsPayload.kind === "error") {
      setToast(notificationSettingsPayload.message);
      return;
    }
    const [dashboardPayload, reservationsPayload, statisticsPayload, usersPayload, auditPayload] = await Promise.all([
      fetchAdminDashboard(date),
      fetchAdminReservations({
        date,
        query: reservationQuery,
        status: statusFilter,
        studyPeriod: reservationPeriodFilter
      }),
      fetchAdminStatistics({ from: date, to: date }),
      fetchAdminUsersForSection({ activeSection, query: userQuery, status: userStatusFilter }),
      fetchAdminAuditActions({ action: auditActionFilter, query: auditQuery })
    ]);
    const readError = firstAdminReadError([
      dashboardPayload,
      reservationsPayload,
      statisticsPayload,
      usersPayload,
      auditPayload
    ]);
    if (readError) {
      setToast(readError);
      return;
    }
    setPeriods(settingsPayload.data);
    setNotificationSettings(notificationSettingsPayload.data);
    setDashboardPeriods(dashboardPayload.kind === "ok" ? dashboardPayload.data : []);
    setReservations(reservationsPayload.kind === "ok" ? reservationsPayload.data : []);
    setStatistics(statisticsPayload.kind === "ok" ? statisticsPayload.data : null);
    setUsers(usersPayload.kind === "ok" ? usersPayload.data : []);
    setAuditActions(auditPayload.kind === "ok" ? auditPayload.data : []);
    if (selectedUserId) {
      await refreshSelectedUser(selectedUserId);
    }
  }

  async function saveSettings(): Promise<void> {
    const [periodsOk, notificationsOk] = await Promise.all([
      saveAdminSettings({ date, periods }),
      saveAdminNotificationSettings(notificationSettings)
    ]);
    const ok = periodsOk && notificationsOk;
    setToast(ok ? "설정이 저장되었습니다." : "설정 저장에 실패했습니다.");
    await refresh();
  }

  async function sendNotification(period: AdminDashboardPeriod, force: boolean): Promise<void> {
    const ok = await sendClosedPeriodNotification(period, force);
    setToast(ok ? "마감 명단을 전송했습니다." : "마감 명단 전송에 실패했습니다.");
    await refresh();
  }

  async function markNoShow(reservationId: string): Promise<void> {
    const ok = await markReservationNoShow(reservationId);
    setToast(ok ? "노쇼 처리와 영구 차단을 적용했습니다." : "노쇼 처리 실패");
    await refresh();
  }

  async function cancelReservation(reservationId: string): Promise<void> {
    const ok = await cancelAdminReservation(reservationId);
    setToast(ok ? "예약을 관리자 취소 처리했습니다." : "예약 취소 실패");
    await refresh();
  }

  async function removeRestriction(userId: string): Promise<void> {
    const ok = await removeUserRestriction(userId);
    setToast(ok ? "예약 제한을 해제했습니다." : "제한 해제 실패");
    await refresh();
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
      status: draft.status
    });
    setToast(ok ? "학생 제재를 적용했습니다." : "학생 제재 적용 실패");
    await refresh();
  }

  async function applyShadowBan(userId: string): Promise<void> {
    const ok = await applyUserRestriction(userId, SHADOW_BAN_RESTRICTION);
    setToast(ok ? "블랙리스트에 추가했습니다." : "블랙리스트 추가 실패");
    await refresh();
  }

  function updatePeriod(studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>): void {
    setPeriods((current) => updatePeriodSetting(current, studyPeriod, patch));
  }

  function updateNotificationSettings(patch: Partial<AdminNotificationSettings>): void {
    setNotificationSettings((current) => ({ ...current, ...patch, id: "global" }));
  }

  function selectStatus(nextStatus: AdminReservationStatusFilter): void {
    setStatusFilter(nextStatus);
    writeReservationStatusToHistory(window.location, window.history, nextStatus);
  }

  async function viewUser(userId: string): Promise<void> {
    setSelectedUserId(userId);
    setActiveSection("students");
    await refreshSelectedUser(userId);
  }

  function clearSelectedUser(): void {
    setSelectedUserId(null);
    setSelectedUserDetail(null);
  }

  async function refreshSelectedUser(userId: string): Promise<void> {
    const result = await fetchAdminUserDetail(userId);
    if (result.kind === "ok") {
      setSelectedUserDetail(result.data);
      return;
    }
    setToast(result.kind === "unauthorized" ? "관리자 로그인이 필요합니다." : result.message);
  }

  async function copyReservationsCsv(): Promise<void> {
    await navigator.clipboard.writeText(buildReservationCsv(reservations));
    setToast("현재 예약 목록을 복사했습니다.");
  }

  function setRestrictionDraft(userId: string, patch: Partial<UserRestrictionDraft>): void {
    setRestrictionDrafts((current) => patchRestrictionDrafts(current, userId, patch));
  }

  return {
    activeSection,
    auditActionFilter,
    auditActions,
    auditQuery,
    applyRestriction,
    applyShadowBan,
    cancelReservation,
    clearSelectedUser,
    copyReservationsCsv,
    dashboardPeriods,
    date,
    markNoShow,
    notificationSettings,
    periods,
    refresh,
    removeRestriction,
    reservationPeriodFilter,
    reservationQuery,
    reservations,
    restrictionDrafts,
    saveSettings,
    selectedUserDetail,
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
    statistics,
    toast,
    updateNotificationSettings,
    updatePeriod,
    userQuery,
    userStatusFilter,
    users,
    viewUser
  };
}
