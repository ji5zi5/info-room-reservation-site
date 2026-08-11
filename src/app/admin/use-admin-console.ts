"use client";

import { useEffect, useState } from "react";

import {
  applyUserRestriction,
  type AdminMutationResult,
  type ApplyRestrictionData,
  type CancelReservationData,
  type NoShowReservationData,
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
import {
  parseReservationDeepLink,
  readReservationStatusFromLocation,
  replaceReservationDeepLinkSearch,
  resolveReservationDeepLink,
  writeReservationStatusToHistory,
  type DeepLinkTarget
} from "./admin-console-url";
import {
  adminMutationFeedback,
  adminSettingsMutationFeedback,
  type AdminMutationFeedbackDecision,
  reconcileClosedPeriodNotificationFeedback,
  sendClosedPeriodNotificationFeedback
} from "./admin-mutation-feedback";
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
  type AdminReservation,
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
  const [deepLinkTarget, setDeepLinkTarget] = useState<DeepLinkTarget | null>(null);
  const [deepLinkCancellation, setDeepLinkCancellation] = useState<AdminReservation | null>(null);
  const reads = useAdminConsoleReads({
    activeSection,
    auditActionFilter,
    auditQuery,
    date,
    deepLinkTarget,
    reservationPeriodFilter,
    reservationQuery,
    selectedUserId,
    statusFilter,
    userQuery,
    userStatusFilter
  });

  useEffect(() => {
    const parsed = parseReservationDeepLink(window.location.search);
    switch (parsed.kind) {
      case "absent":
        setStatusFilter(readReservationStatusFromLocation(window.location));
        return;
      case "invalid":
        replaceReservationDeepLinkSearch(window.location, window.history, parsed.cleanedSearch);
        setToast("예약 링크가 올바르지 않습니다.");
        return;
      case "valid":
        setActiveSection("reservations");
        setDate(parsed.target.date);
        setStatusFilter("CONFIRMED");
        setDeepLinkTarget(parsed.target);
        return;
    }
  }, []);

  useEffect(() => {
    if (deepLinkTarget === null) {
      return;
    }
    switch (reads.deepLinkRead.kind) {
      case "idle":
      case "loading":
        return;
      case "error":
        if (sameDeepLinkTarget(reads.deepLinkRead.target, deepLinkTarget)) {
          setToast(reads.deepLinkRead.message);
          setDeepLinkTarget(null);
        }
        return;
      case "missing":
        if (sameDeepLinkTarget(reads.deepLinkRead.target, deepLinkTarget)) {
          cleanResolvedDeepLink(false);
          setToast("해당 확정 예약을 찾을 수 없습니다.");
        }
        return;
      case "found":
        if (sameDeepLinkTarget(reads.deepLinkRead.target, deepLinkTarget)) {
          setDeepLinkCancellation(reads.deepLinkRead.reservation);
          cleanResolvedDeepLink(true);
        }
        return;
    }
  }, [deepLinkTarget, reads.deepLinkRead]);

  function cleanResolvedDeepLink(found: boolean): void {
    const resolution = resolveReservationDeepLink(window.location.search, () => found);
    if (resolution.kind === "found" || resolution.kind === "missing") {
      replaceReservationDeepLinkSearch(window.location, window.history, resolution.cleanedSearch);
    }
    setDeepLinkTarget(null);
  }

  async function refresh(): Promise<void> {
    if (activeSection === "settings") {
      reads.refreshPeriods();
      reads.refreshNotificationSettings();
      return;
    }
    reads.refreshActive();
  }

  async function saveSettings(): Promise<void> {
    const [periods, notifications] = await Promise.all([
      saveAdminSettings({ date, periods: reads.periods }),
      saveAdminNotificationSettings(reads.notificationSettings)
    ]);
    const feedback = adminSettingsMutationFeedback({ notifications, periods });
    setToast(feedback.message);
    if (feedback.refreshPeriods) {
      reads.refreshPeriods();
    }
    if (feedback.refreshNotifications) {
      reads.refreshNotificationSettings();
    }
  }

  async function sendNotification(period: AdminDashboardPeriod): Promise<void> {
    applyFeedback(sendClosedPeriodNotificationFeedback(await sendClosedPeriodNotification(period)));
  }

  async function reconcileNotification(
    item: AdminNotificationBacklogItem,
    action: AdminNotificationReconciliationAction
  ): Promise<void> {
    applyFeedback(
      reconcileClosedPeriodNotificationFeedback(await reconcileClosedPeriodNotification(item, action), action)
    );
  }

  async function markNoShow(reservationId: string): Promise<AdminMutationResult<NoShowReservationData>> {
    const result = await markReservationNoShow(reservationId);
    applyFeedback(
      adminMutationFeedback(
        result,
        result.kind === "ok"
          ? `노쇼 처리와 영구 차단을 적용했습니다. 향후 확정 예약 ${result.data.cancelledFutureReservationCount}건을 취소했습니다.`
          : "노쇼 처리와 영구 차단을 적용했습니다."
      )
    );
    return result;
  }

  async function cancelReservation(
    reservationId: string,
    reason: string
  ): Promise<AdminMutationResult<CancelReservationData>> {
    const result = await cancelAdminReservation(reservationId, reason);
    applyFeedback(adminMutationFeedback(result, "예약을 관리자 취소 처리했습니다."));
    return result;
  }

  async function removeRestriction(userId: string): Promise<void> {
    applyFeedback(adminMutationFeedback(await removeUserRestriction(userId), "예약 제한을 해제했습니다."));
  }

  async function applyRestriction(userId: string): Promise<AdminMutationResult<ApplyRestrictionData>> {
    const draft = restrictionDrafts[userId] ?? DEFAULT_RESTRICTION_DRAFT;
    const reason = draft.reason.trim();
    if (!reason) {
      setToast("제재 사유를 입력하세요.");
      return {
        kind: "error",
        message: "제재 사유를 입력하세요.",
        retryAfterMs: null,
        retryable: false,
        status: null
      };
    }
    const parsedDays = Number.parseInt(draft.days, 10);
    const result = await applyUserRestriction(userId, {
      days: draft.status === "RESTRICTED" ? Math.max(parsedDays || 7, 1) : null,
      reason,
      shadowBanProfile: draft.shadowBanProfile,
      status: draft.status
    });
    applyFeedback(
      adminMutationFeedback(
        result,
        result.kind === "ok" && draft.status === "BANNED"
          ? `학생 제재를 적용했습니다. 향후 확정 예약 ${result.data.cancelledFutureReservationCount}건을 취소했습니다.`
          : "학생 제재를 적용했습니다."
      )
    );
    if (result.kind === "ok") {
      setRestrictionDrafts((current) => ({ ...current, [userId]: DEFAULT_RESTRICTION_DRAFT }));
    }
    return result;
  }

  async function applyShadowBan(userId: string): Promise<void> {
    applyFeedback(
      adminMutationFeedback(await applyUserRestriction(userId, SHADOW_BAN_RESTRICTION), "블랙리스트에 추가했습니다.")
    );
  }

  function applyFeedback(feedback: AdminMutationFeedbackDecision): void {
    setToast(feedback.message);
    if (feedback.refresh !== "none") {
      reads.refreshActive();
    }
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
    consumeDeepLinkCancellation: () => setDeepLinkCancellation(null),
    dashboardPeriods: reads.dashboardPeriods,
    date,
    deepLinkCancellation,
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

function sameDeepLinkTarget(left: DeepLinkTarget, right: DeepLinkTarget): boolean {
  return left.date === right.date && left.reservationId === right.reservationId;
}
