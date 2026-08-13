"use client";

import { useEffect, useState } from "react";

import {
  fetchAdminAuditActions,
  fetchAdminDashboard,
  fetchAdminNotificationSettings,
  fetchAdminReservations,
  fetchAdminSettings,
  fetchAdminStatistics,
  fetchAdminUserDetail,
  type AdminReadPage
} from "./admin-read-api-client";
import { firstAdminReadError } from "./admin-read-error";
import type { AdminSection } from "./admin-console-state";
import type { DeepLinkTarget } from "./admin-console-url";
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
  readonly deepLinkTarget: DeepLinkTarget | null;
  readonly reservationPeriodFilter: AdminTypes.AdminReservationStudyPeriodFilter;
  readonly reservationQuery: string;
  readonly selectedUserId: string | null;
  readonly statusFilter: AdminTypes.AdminReservationStatusFilter;
  readonly userQuery: string;
  readonly userStatusFilter: AdminTypes.AdminUserStatusFilter;
};

export type AdminReservationDeepLinkRead =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly target: DeepLinkTarget }
  | { readonly kind: "found"; readonly reservation: AdminTypes.AdminReservation; readonly target: DeepLinkTarget }
  | { readonly kind: "missing"; readonly target: DeepLinkTarget }
  | { readonly kind: "error"; readonly message: string; readonly target: DeepLinkTarget };

export function useAdminConsoleReads(input: AdminConsoleReadInput) {
  const [periods, setPeriods] = useState<readonly AdminTypes.AdminPeriodSetting[]>([]);
  const [notificationSettings, setNotificationSettings] =
    useState<AdminTypes.AdminNotificationSettings>(DEFAULT_NOTIFICATION_SETTINGS);
  const [dashboardPeriods, setDashboardPeriods] =
    useState<readonly AdminTypes.AdminDashboardPeriod[]>([]);
  const [notificationBacklog, setNotificationBacklog] =
    useState<readonly AdminTypes.AdminNotificationBacklogItem[]>([]);
  const [reservationPage, setReservationPage] =
    useState<AdminReadPage<AdminTypes.AdminReservation> | null>(null);
  const [statistics, setStatistics] = useState<AdminTypes.AdminStatistics | null>(null);
  const [userPage, setUserPage] = useState<AdminReadPage<AdminTypes.AdminUser> | null>(null);
  const [auditPage, setAuditPage] =
    useState<AdminReadPage<AdminTypes.AdminAuditAction> | null>(null);
  const [selectedUserDetail, setSelectedUserDetail] =
    useState<AdminTypes.AdminUserDetail | null>(null);
  const [deepLinkRead, setDeepLinkRead] = useState<AdminReservationDeepLinkRead>({ kind: "idle" });
  const [periodError, setPeriodError] = useState<string | null>(null);
  const [notificationSettingsError, setNotificationSettingsError] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [periodRevision, setPeriodRevision] = useState(0);
  const [notificationSettingsRevision, setNotificationSettingsRevision] = useState(0);
  const [sectionRevision, setSectionRevision] = useState(0);
  const [detailRevision, setDetailRevision] = useState(0);
  const debouncedAuditQuery = useDebouncedValue(input.auditQuery);
  const debouncedReservationQuery = useDebouncedValue(input.reservationQuery);
  const debouncedUserQuery = useDebouncedValue(input.userQuery);

  useEffect(() => {
    if (input.deepLinkTarget === null) {
      setDeepLinkRead({ kind: "idle" });
      return;
    }
    const target = input.deepLinkTarget;
    const controller = new AbortController();
    setDeepLinkRead({ kind: "loading", target });
    void loadDeepLinkReservation(target, controller.signal).catch((loadError: unknown) => {
      if (controller.signal.aborted || (loadError instanceof DOMException && loadError.name === "AbortError")) {
        return;
      }
      setDeepLinkRead({ kind: "error", message: "예약 정보를 불러오지 못했습니다.", target });
    });
    return () => controller.abort();
  }, [input.deepLinkTarget]);

  useEffect(() => {
    const controller = new AbortController();
    setPeriodError(null);
    void loadPeriods(controller.signal).catch((loadError: unknown) => {
      handleReadFailure(loadError, controller.signal, setPeriodError);
    });
    return () => controller.abort();
  }, [input.date, periodRevision]);

  useEffect(() => {
    const controller = new AbortController();
    setNotificationSettingsError(null);
    void loadNotificationSettings(controller.signal).catch((loadError: unknown) => {
      handleReadFailure(loadError, controller.signal, setNotificationSettingsError);
    });
    return () => controller.abort();
  }, [notificationSettingsRevision]);

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

  async function loadPeriods(signal: AbortSignal): Promise<void> {
    const settings = await fetchAdminSettings(input.date, { signal });
    if (signal.aborted) {
      return;
    }
    if (settings.kind !== "ok") {
      setPeriodError(firstAdminReadError([settings]) ?? "시간대 설정을 불러오지 못했습니다.");
      return;
    }
    setPeriods(settings.data);
  }

  async function loadNotificationSettings(signal: AbortSignal): Promise<void> {
    const notifications = await fetchAdminNotificationSettings({ signal });
    if (signal.aborted) {
      return;
    }
    if (notifications.kind !== "ok") {
      setNotificationSettingsError(firstAdminReadError([notifications]) ?? "알림 설정을 불러오지 못했습니다.");
      return;
    }
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
      setReservationPage(result.data);
      return;
    }
    setSectionError(firstAdminReadError([result]) ?? "예약 목록을 불러오지 못했습니다.");
  }

  async function loadDeepLinkReservation(target: DeepLinkTarget, signal: AbortSignal): Promise<void> {
    const result = await fetchAdminReservations({
      date: target.date,
      query: "",
      reservationId: target.reservationId,
      status: "CONFIRMED",
      studyPeriod: "ALL"
    }, { signal });
    if (signal.aborted) {
      return;
    }
    if (result.kind !== "ok") {
      setDeepLinkRead({
        kind: "error",
        message: firstAdminReadError([result]) ?? "예약 정보를 불러오지 못했습니다.",
        target
      });
      return;
    }
    const reservation = result.data.items.find(
      (candidate) =>
        candidate.id === target.reservationId &&
        candidate.date === target.date &&
        candidate.status === "CONFIRMED"
    );
    setDeepLinkRead(
      reservation
        ? { kind: "found", reservation, target }
        : { kind: "missing", target }
    );
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
      setUserPage(result.data);
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
      setAuditPage(result.data);
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
    auditActions: auditPage?.items ?? [],
    auditPage,
    clearSelectedUserDetail: () => {
      setDetailError(null);
      setSelectedUserDetail(null);
    },
    dashboardPeriods,
    deepLinkRead,
    error: detailError ?? sectionError ?? periodError ?? notificationSettingsError,
    notificationBacklog,
    notificationSettings,
    periods,
    refreshActive,
    refreshNotificationSettings: () => setNotificationSettingsRevision((current) => current + 1),
    refreshPeriods: () => setPeriodRevision((current) => current + 1),
    reservationPage,
    reservations: reservationPage?.items ?? [],
    selectedUserDetail,
    setNotificationSettings,
    setPeriods,
    statistics,
    userPage,
    users: userPage?.items ?? []
  };
}
