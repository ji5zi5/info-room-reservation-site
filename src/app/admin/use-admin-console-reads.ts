"use client";

import { useEffect, useState } from "react";

import {
  fetchAdminAuditActions,
  fetchAdminDashboard,
  fetchAdminNotificationSettings,
  fetchAdminReservations,
  fetchAdminSettings,
  fetchAdminStatistics,
  fetchAdminUserDetail
} from "./admin-read-api-client";
import { firstAdminReadError } from "./admin-read-error";
import type { AdminSection } from "./admin-console-state";
import type * as AdminTypes from "./admin-types";
import { fetchAdminUsersForSection } from "./admin-user-fetching";
import { useDebouncedValue } from "./use-debounced-value";

const DEFAULT_NOTIFICATION_SETTINGS = {
  closedPeriodNotificationsEnabled: true,
  id: "global",
  reservationCreatedNotificationsEnabled: false
} satisfies AdminTypes.AdminNotificationSettings;

type AdminConsoleReadInput = {
  readonly activeSection: AdminSection;
  readonly auditActionFilter: AdminTypes.AdminAuditActionFilter;
  readonly auditQuery: string;
  readonly date: string;
  readonly reservationPeriodFilter: AdminTypes.AdminReservationStudyPeriodFilter;
  readonly reservationQuery: string;
  readonly selectedUserId: string | null;
  readonly statusFilter: AdminTypes.AdminReservationStatusFilter;
  readonly userQuery: string;
  readonly userStatusFilter: AdminTypes.AdminUserStatusFilter;
};

export function useAdminConsoleReads(input: AdminConsoleReadInput) {
  const [periods, setPeriods] = useState<readonly AdminTypes.AdminPeriodSetting[]>([]);
  const [notificationSettings, setNotificationSettings] =
    useState<AdminTypes.AdminNotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [dashboardPeriods, setDashboardPeriods] =
    useState<readonly AdminTypes.AdminDashboardPeriod[]>([]);
  const [notificationBacklog, setNotificationBacklog] =
    useState<readonly AdminTypes.AdminNotificationBacklogItem[]>([]);
  const [reservations, setReservations] =
    useState<readonly AdminTypes.AdminReservation[]>([]);
  const [statistics, setStatistics] = useState<AdminTypes.AdminStatistics | null>(null);
  const [users, setUsers] = useState<readonly AdminTypes.AdminUser[]>([]);
  const [auditActions, setAuditActions] =
    useState<readonly AdminTypes.AdminAuditAction[]>([]);
  const [selectedUserDetail, setSelectedUserDetail] =
    useState<AdminTypes.AdminUserDetail | null>(null);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sharedRevision, setSharedRevision] = useState(0);
  const [sectionRevision, setSectionRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const debouncedAuditQuery = useDebouncedValue(input.auditQuery);
  const debouncedReservationQuery = useDebouncedValue(input.reservationQuery);
  const debouncedUserQuery = useDebouncedValue(input.userQuery);

  useEffect(() => {
    const controller = new AbortController();
    setSharedError(null);
    void loadSharedData(controller.signal).catch((loadError: unknown) => {
      handleReadFailure(loadError, controller.signal, setSharedError);
    });
    return () => controller.abort();
  }, [input.date, sharedRevision]);

  useEffect(() => {
    const controller = new AbortController();
    setSectionError(null);
    void loadActiveSection(controller.signal).catch((loadError: unknown) => {
      handleReadFailure(loadError, controller.signal, setSectionError);
    });
    return () => controller.abort();
  }, [
    input.activeSection,
    input.auditActionFilter,
    debouncedAuditQuery,
    input.date,
    input.reservationPeriodFilter,
    debouncedReservationQuery,
    sectionRevision,
    input.statusFilter,
    debouncedUserQuery,
    input.userStatusFilter
  ]);

  useEffect(() => {
    if (
      !input.selectedUserId ||
      (input.activeSection !== "blacklist" && input.activeSection !== "students")
    ) {
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailError(null);
    void loadSelectedUser(input.selectedUserId, controller.signal).catch((loadError: unknown) => {
      handleReadFailure(loadError, controller.signal, setDetailError);
    });
    return () => controller.abort();
  }, [input.activeSection, detailRevision, input.selectedUserId]);

  async function loadSharedData(signal: AbortSignal): Promise<void> {
    const [settings, notifications] = await Promise.all([
      fetchAdminSettings(input.date, { signal }),
      fetchAdminNotificationSettings({ signal })
    ]);
    if (signal.aborted) {
      return;
    }
    const readError = firstAdminReadError([settings, notifications]);
    if (readError || settings.kind !== "ok" || notifications.kind !== "ok") {
      setSharedError(readError ?? "관리자 설정을 불러오지 못했습니다.");
      return;
    }
    setPeriods(settings.data);
    setNotificationSettings(notifications.data);
  }

  async function loadActiveSection(signal: AbortSignal): Promise<void> {
    const options = { signal };
    switch (input.activeSection) {
      case "dashboard": {
        const [dashboard, statisticsResult] = await Promise.all([
          fetchAdminDashboard(input.date, options),
          fetchAdminStatistics({ from: input.date, to: input.date }, options)
        ]);
        if (signal.aborted) {
          return;
        }
        const readError = firstAdminReadError([dashboard, statisticsResult]);
        if (readError || dashboard.kind !== "ok" || statisticsResult.kind !== "ok") {
          setSectionError(readError ?? "운영 현황을 불러오지 못했습니다.");
          return;
        }
        setDashboardPeriods(dashboard.data.periods);
        setNotificationBacklog(dashboard.data.notificationBacklog);
        setStatistics(statisticsResult.data);
        return;
      }
      case "reservations":
        await loadReservations(signal);
        return;
      case "students":
      case "blacklist":
        await loadUsers(signal);
        return;
      case "audit":
        await loadAudit(signal);
        return;
      case "settings":
        return;
    }
  }

  async function loadReservations(signal: AbortSignal): Promise<void> {
    const result = await fetchAdminReservations({
      date: input.date,
      query: debouncedReservationQuery,
      status: input.statusFilter,
      studyPeriod: input.reservationPeriodFilter
    }, { signal });
    if (signal.aborted) {
      return;
    }
    if (result.kind === "ok") {
      setReservations(result.data);
      return;
    }
    setSectionError(firstAdminReadError([result]) ?? "예약 목록을 불러오지 못했습니다.");
  }

  async function loadUsers(signal: AbortSignal): Promise<void> {
    const result = await fetchAdminUsersForSection({
      activeSection: input.activeSection,
      query: debouncedUserQuery,
      status: input.userStatusFilter
    }, { signal });
    if (signal.aborted) {
      return;
    }
    if (result.kind === "ok") {
      setUsers(result.data);
      return;
    }
    setSectionError(firstAdminReadError([result]) ?? "학생 목록을 불러오지 못했습니다.");
  }

  async function loadAudit(signal: AbortSignal): Promise<void> {
    const result = await fetchAdminAuditActions({
      action: input.auditActionFilter,
      query: debouncedAuditQuery
    }, { signal });
    if (signal.aborted) {
      return;
    }
    if (result.kind === "ok") {
      setAuditActions(result.data);
      return;
    }
    setSectionError(firstAdminReadError([result]) ?? "감사 기록을 불러오지 못했습니다.");
  }

  async function loadSelectedUser(userId: string, signal: AbortSignal): Promise<void> {
    const result = await fetchAdminUserDetail(userId, { signal });
    if (signal.aborted) {
      return;
    }
    if (result.kind === "ok") {
      setSelectedUserDetail(result.data);
      return;
    }
    setDetailError(firstAdminReadError([result]) ?? "학생 상세를 불러오지 못했습니다.");
  }

  function handleReadFailure(
    loadError: unknown,
    signal: AbortSignal,
    report: (message: string) => void
  ): void {
    if (signal.aborted || (loadError instanceof DOMException && loadError.name === "AbortError")) {
      return;
    }
    report("관리자 데이터를 불러오지 못했습니다.");
  }

  function refreshActive(): void {
    setSectionRevision((current) => current + 1);
    if (
      input.selectedUserId &&
      (input.activeSection === "blacklist" || input.activeSection === "students")
    ) {
      setDetailRevision((current) => current + 1);
    }
  }

  return {
    auditActions,
    clearSelectedUserDetail: () => {
      setDetailError(null);
      setSelectedUserDetail(null);
    },
    dashboardPeriods,
    error: detailError ?? sectionError ?? sharedError,
    notificationBacklog,
    notificationSettings,
    periods,
    refreshActive,
    refreshShared: () => setSharedRevision((current) => current + 1),
    reservations,
    selectedUserDetail,
    setNotificationSettings,
    setPeriods,
    statistics,
    users
  };
}
