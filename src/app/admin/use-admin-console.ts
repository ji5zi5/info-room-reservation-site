"use client";

import { useEffect, useState } from "react";

import { parseAdminReservationStatus } from "@/lib/admin-reservations";
import { parseAdminUserStatusFilter } from "@/lib/admin-users";

import {
  AdminDashboardPayloadSchema,
  AdminReservationsPayloadSchema,
  AdminSettingsPayloadSchema,
  AdminUsersPayloadSchema,
  type AdminDashboardPeriod,
  type AdminPeriodSetting,
  type AdminReservation,
  type AdminReservationStatusFilter,
  type AdminUser,
  type AdminUserStatusFilter,
  type StudyPeriod
} from "./admin-types";

type UserRestrictionDraft = {
  readonly days: string;
  readonly reason: string;
  readonly status: "BANNED" | "RESTRICTED";
};

const DEFAULT_RESTRICTION_DRAFT = {
  days: "7",
  reason: "정보실 예약 제한",
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

export function useAdminConsole(): {
  readonly applyRestriction: (userId: string) => Promise<void>;
  readonly dashboardPeriods: readonly AdminDashboardPeriod[];
  readonly date: string;
  readonly markNoShow: (reservationId: string) => Promise<void>;
  readonly periods: readonly AdminPeriodSetting[];
  readonly refresh: () => Promise<void>;
  readonly removeRestriction: (userId: string) => Promise<void>;
  readonly reservations: readonly AdminReservation[];
  readonly restrictionDrafts: Readonly<Record<string, UserRestrictionDraft>>;
  readonly saveSettings: () => Promise<void>;
  readonly selectStatus: (status: AdminReservationStatusFilter) => void;
  readonly sendNotification: (period: AdminDashboardPeriod, force: boolean) => Promise<void>;
  readonly setDate: (date: string) => void;
  readonly setRestrictionDraft: (userId: string, patch: Partial<UserRestrictionDraft>) => void;
  readonly setUserQuery: (query: string) => void;
  readonly setUserStatusFilter: (status: AdminUserStatusFilter) => void;
  readonly statusFilter: AdminReservationStatusFilter;
  readonly toast: string | null;
  readonly updatePeriod: (studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>) => void;
  readonly userQuery: string;
  readonly userStatusFilter: AdminUserStatusFilter;
  readonly users: readonly AdminUser[];
} {
  const [date, setDate] = useState(todayKst());
  const [periods, setPeriods] = useState<readonly AdminPeriodSetting[]>([]);
  const [dashboardPeriods, setDashboardPeriods] = useState<readonly AdminDashboardPeriod[]>([]);
  const [reservations, setReservations] = useState<readonly AdminReservation[]>([]);
  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [statusFilter, setStatusFilter] = useState<AdminReservationStatusFilter>("CONFIRMED");
  const [userStatusFilter, setUserStatusFilter] = useState<AdminUserStatusFilter>("ALL");
  const [userQuery, setUserQuery] = useState("");
  const [restrictionDrafts, setRestrictionDrafts] = useState<Readonly<Record<string, UserRestrictionDraft>>>({});
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setStatusFilter(parseAdminReservationStatus(new URLSearchParams(window.location.search).get("status")));
  }, []);

  useEffect(() => {
    void refresh();
  }, [date, statusFilter, userQuery, userStatusFilter]);

  async function refresh(): Promise<void> {
    const settingsResponse = await fetch(`/api/admin/period-settings?date=${date}`);
    if (settingsResponse.status === 401 || settingsResponse.status === 403) {
      setToast("관리자 로그인이 필요합니다.");
      return;
    }
    const dashboardResponse = await fetch(`/api/admin/dashboard?date=${date}`);
    const reservationsResponse = await fetch(`/api/admin/reservations?date=${date}&status=${statusFilter}`);
    const usersResponse = await fetch(`/api/admin/users?query=${encodeURIComponent(userQuery)}&bookingStatus=${userStatusFilter}`);
    const settingsPayload = AdminSettingsPayloadSchema.parse(await settingsResponse.json());
    const dashboardPayload = AdminDashboardPayloadSchema.parse(await dashboardResponse.json());
    const reservationsPayload = AdminReservationsPayloadSchema.parse(await reservationsResponse.json());
    const usersPayload = AdminUsersPayloadSchema.parse(await usersResponse.json());
    setPeriods(settingsPayload.periods);
    setDashboardPeriods(dashboardPayload.periods);
    setReservations(reservationsPayload.reservations);
    setUsers(usersPayload.users);
  }

  async function saveSettings(): Promise<void> {
    const response = await fetch("/api/admin/period-settings", {
      body: JSON.stringify({ date, periods }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
    setToast(response.ok ? "설정이 저장되었습니다." : "설정 저장에 실패했습니다.");
    await refresh();
  }

  async function sendNotification(period: AdminDashboardPeriod, force: boolean): Promise<void> {
    const response = await fetch("/api/admin/notifications/closed-periods/send", {
      body: JSON.stringify({ date: period.date, force, studyPeriod: period.studyPeriod }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    setToast(response.ok ? "마감 명단을 전송했습니다." : "마감 명단 전송에 실패했습니다.");
    await refresh();
  }

  async function markNoShow(reservationId: string): Promise<void> {
    const response = await fetch(`/api/admin/reservations/${reservationId}/no-show`, {
      body: JSON.stringify({ days: 7, reason: "정보실 예약 노쇼" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    setToast(response.ok ? "노쇼 처리와 예약 제한을 적용했습니다." : "노쇼 처리 실패");
    await refresh();
  }

  async function removeRestriction(userId: string): Promise<void> {
    const response = await fetch(`/api/admin/users/${userId}/restriction`, { method: "DELETE" });
    setToast(response.ok ? "예약 제한을 해제했습니다." : "제한 해제 실패");
    await refresh();
  }

  async function applyRestriction(userId: string): Promise<void> {
    const draft = restrictionDrafts[userId] ?? DEFAULT_RESTRICTION_DRAFT;
    const parsedDays = Number.parseInt(draft.days, 10);
    const response = await fetch(`/api/admin/users/${userId}/restriction`, {
      body: JSON.stringify({
        days: draft.status === "RESTRICTED" ? Math.max(parsedDays || 7, 1) : null,
        reason: draft.reason,
        status: draft.status
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    setToast(response.ok ? "예약 제한을 적용했습니다." : "예약 제한 적용 실패");
    await refresh();
  }

  function updatePeriod(studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>): void {
    setPeriods((current) => current.map((period) => (period.studyPeriod === studyPeriod ? { ...period, ...patch } : period)));
  }

  function selectStatus(nextStatus: AdminReservationStatusFilter): void {
    setStatusFilter(nextStatus);
    const url = new URL(window.location.href);
    url.searchParams.set("status", nextStatus);
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  function setRestrictionDraft(userId: string, patch: Partial<UserRestrictionDraft>): void {
    setRestrictionDrafts((current) => ({
      ...current,
      [userId]: { ...(current[userId] ?? DEFAULT_RESTRICTION_DRAFT), ...patch }
    }));
  }

  return {
    applyRestriction,
    dashboardPeriods,
    date,
    markNoShow,
    periods,
    refresh,
    removeRestriction,
    reservations,
    restrictionDrafts,
    saveSettings,
    selectStatus,
    sendNotification,
    setDate,
    setRestrictionDraft,
    setUserQuery,
    setUserStatusFilter,
    statusFilter,
    toast,
    updatePeriod,
    userQuery,
    userStatusFilter,
    users
  };
}

function todayKst(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Asia/Seoul",
    year: "numeric"
  }).format(new Date());
}
