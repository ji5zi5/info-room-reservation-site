"use client";

import { useEffect, useState } from "react";

import { parseAdminReservationStatus } from "@/lib/admin-reservations";
import { parseAdminUserStatusFilter } from "@/lib/admin-users";

import {
  applyUserRestriction,
  cancelAdminReservation,
  fetchAdminAuditActions,
  fetchAdminDashboard,
  fetchAdminReservations,
  fetchAdminSettings,
  fetchAdminStatistics,
  fetchAdminUserDetail,
  fetchAdminUsers,
  markReservationNoShow,
  removeUserRestriction,
  revokeUserSessions,
  saveAdminSettings,
  sendClosedPeriodNotification,
  updatePeriodSetting
} from "./admin-api-client";
import { todayKst } from "./admin-date";
import { buildReservationCsv } from "./admin-csv";
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

export type { AdminSection } from "./admin-console-state";

export function useAdminConsole(): AdminConsoleState {
  const [activeSection, setActiveSection] = useState<AdminSection>("dashboard");
  const [date, setDate] = useState(todayKst());
  const [periods, setPeriods] = useState<readonly AdminPeriodSetting[]>([]);
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
    setStatusFilter(parseAdminReservationStatus(new URLSearchParams(window.location.search).get("status")));
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
    const settingsPayload = await fetchAdminSettings(date);
    if (settingsPayload === "unauthorized") {
      setToast("관리자 로그인이 필요합니다.");
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
      fetchAdminUsers({ query: userQuery, status: userStatusFilter }),
      fetchAdminAuditActions({ action: auditActionFilter, query: auditQuery })
    ]);
    setPeriods(settingsPayload);
    setDashboardPeriods(dashboardPayload);
    setReservations(reservationsPayload);
    setStatistics(statisticsPayload);
    setUsers(usersPayload);
    setAuditActions(auditPayload);
    if (selectedUserId) {
      await refreshSelectedUser(selectedUserId);
    }
  }

  async function saveSettings(): Promise<void> {
    const ok = await saveAdminSettings({ date, periods });
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
    setToast(ok ? "노쇼 처리와 예약 제한을 적용했습니다." : "노쇼 처리 실패");
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
    const parsedDays = Number.parseInt(draft.days, 10);
    const ok = await applyUserRestriction(userId, {
      days: draft.status === "RESTRICTED" ? Math.max(parsedDays || 7, 1) : null,
      reason: draft.reason,
      status: draft.status
    });
    setToast(ok ? "예약 제한을 적용했습니다." : "예약 제한 적용 실패");
    await refresh();
  }

  async function applyRestrictionPreset(userId: string, days: number): Promise<void> {
    const ok = await applyUserRestriction(userId, {
      days,
      reason: "정보실 예약 제한",
      status: "RESTRICTED"
    });
    setToast(ok ? `${days}일 예약 제한을 적용했습니다.` : "예약 제한 적용 실패");
    await refresh();
  }

  async function banUser(userId: string): Promise<void> {
    const ok = await applyUserRestriction(userId, {
      days: null,
      reason: "정보실 예약 영구 차단",
      status: "BANNED"
    });
    setToast(ok ? "학생을 영구 차단했습니다." : "영구 차단 실패");
    await refresh();
  }

  async function revokeSessions(userId: string): Promise<void> {
    const ok = await revokeUserSessions(userId);
    setToast(ok ? "학생의 로그인 세션을 종료했습니다." : "세션 종료 실패");
    await refresh();
  }

  function updatePeriod(studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>): void {
    setPeriods((current) => updatePeriodSetting(current, studyPeriod, patch));
  }

  function selectStatus(nextStatus: AdminReservationStatusFilter): void {
    setStatusFilter(nextStatus);
    const url = new URL(window.location.href);
    url.searchParams.set("status", nextStatus);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
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
    setSelectedUserDetail(await fetchAdminUserDetail(userId));
  }

  async function copyReservationsCsv(): Promise<void> {
    await navigator.clipboard.writeText(buildReservationCsv(reservations));
    setToast("현재 예약 목록을 복사했습니다.");
  }

  function setRestrictionDraft(userId: string, patch: Partial<UserRestrictionDraft>): void {
    setRestrictionDrafts((current) => ({
      ...current,
      [userId]: { ...(current[userId] ?? DEFAULT_RESTRICTION_DRAFT), ...patch }
    }));
  }

  return {
    activeSection,
    auditActionFilter,
    auditActions,
    auditQuery,
    applyRestriction,
    applyRestrictionPreset,
    banUser,
    cancelReservation,
    clearSelectedUser,
    copyReservationsCsv,
    dashboardPeriods,
    date,
    markNoShow,
    periods,
    refresh,
    removeRestriction,
    revokeSessions,
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
    updatePeriod,
    userQuery,
    userStatusFilter,
    users,
    viewUser
  };
}
