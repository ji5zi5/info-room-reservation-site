"use client";

import { useEffect, useRef, useState } from "react";

import {
  applyUserRestriction,
  type AdminMutationResult,
  type ApplyRestrictionData,
  type BulkCancellationData,
  type BulkCancellationInput,
  type CancelReservationData,
  type NoShowReservationData,
  cancelAdminReservation,
  bulkCancelAdminReservations,
  fetchAdminAuditActions,
  fetchAdminOperations,
  fetchAdminReservations,
  fetchAdminUsers,
  markReservationNoShow,
  reconcileClosedPeriodNotification,
  removeUserRestriction,
  repairDiscordOperation,
  saveAdminNotificationSettings,
  saveAdminSettings,
  sendClosedPeriodNotification,
  updatePeriodSetting
} from "./admin-api-client";
import { buildAdminAuditExportUrl, buildAdminReservationExportUrl } from "./admin-read-api-client";
import { todayKst } from "./admin-date";
import {
  parseAdminConsoleDeepLink,
  parseReservationDeepLink,
  readReservationStatusFromLocation,
  replaceReservationDeepLinkSearch,
  resolveAdminConsoleDeepLink,
  resolveReservationDeepLink,
  writeAdminConsoleDeepLink,
  writeReservationStatusToHistory,
  type AdminConsoleDeepLinkTarget,
  type DeepLinkTarget
} from "./admin-console-url";
import {
  adminMutationFeedback,
  adminSettingsMutationFeedback,
  bulkCancellationFeedback,
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
  type AdminAuditAction,
  type AdminAuditActionFilter,
  type AdminDashboardPeriod,
  type AdminNotificationBacklogItem,
  type AdminNotificationReconciliationAction,
  type AdminNotificationSettings,
  type AdminOperationItem,
  type AdminOperationRepairAction,
  type AdminOperationsPayload,
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
  const [operations, setOperations] = useState<AdminOperationsPayload | null>(null);
  const [operationsError, setOperationsError] = useState<string | null>(null);
  const [operationsRevision, setOperationsRevision] = useState(0);
  const [operationReservation, setOperationReservation] = useState<AdminReservation | null>(null);
  const [operationAuditAction, setOperationAuditAction] = useState<AdminAuditAction | null>(null);
  const operationsRequest = useRef(0);
  const deepLinkRequest = useRef(0);
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
    const parameters = new URLSearchParams(window.location.search);
    if (parameters.has("date") || parameters.has("status")) {
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
    }
    const exact = parseAdminConsoleDeepLink(window.location.search);
    if (exact.kind === "invalid") {
      replaceReservationDeepLinkSearch(window.location, window.history, exact.cleanedSearch);
      setToast("운영 링크가 올바르지 않습니다.");
      return;
    }
    if (exact.kind === "valid") {
      void openOperationTarget(exact.target, false);
      return;
    }
    setStatusFilter(readReservationStatusFromLocation(window.location));
  }, []);

  useEffect(() => {
    const request = operationsRequest.current + 1;
    operationsRequest.current = request;
    if (activeSection !== "dashboard") {
      return;
    }
    setOperationsError(null);
    void fetchAdminOperations().then((result) => {
      if (operationsRequest.current !== request) {
        return;
      }
      if (result.kind === "ok") {
        setOperations(result.data);
        return;
      }
      setOperationsError(result.message);
    });
  }, [activeSection, operationsRevision]);

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

  async function repairOperation(
    item: AdminOperationItem,
    action: AdminOperationRepairAction
  ) {
    const result = await repairDiscordOperation(
      item,
      action,
      action === "remove_controls" || action === "abandon" ? item.reservationId : undefined
    );
    if (result.kind === "error") {
      setToast(result.message);
      return result;
    }
    setToast(operationRepairSuccessLabel(action));
    setOperationsRevision((current) => current + 1);
    return result;
  }

  async function navigateToOperationTarget(target: AdminConsoleDeepLinkTarget): Promise<void> {
    await openOperationTarget(target, true);
  }

  async function openOperationTarget(target: AdminConsoleDeepLinkTarget, writeHistory: boolean): Promise<void> {
    const request = deepLinkRequest.current + 1;
    deepLinkRequest.current = request;
    if (writeHistory) {
      const search = writeAdminConsoleDeepLink(window.location.search, target);
      replaceReservationDeepLinkSearch(window.location, window.history, search);
    }
    switch (target.kind) {
      case "reservation": {
        const result = await fetchAdminReservations({
          date,
          query: "",
          reservationId: target.reservationId,
          status: "ALL",
          studyPeriod: "ALL"
        });
        if (deepLinkRequest.current !== request) return;
        const reservation = result.kind === "ok"
          ? result.data.items.find((candidate) => candidate.id === target.reservationId) ?? null
          : null;
        finishOperationDeepLink(target, reservation !== null);
        if (reservation === null) return;
        setOperationReservation(reservation);
        setDate(reservation.date);
        setStatusFilter(reservationStatusFilter(reservation.status));
        setActiveSection("reservations");
        return;
      }
      case "user": {
        const result = await fetchAdminUsers({ query: "", status: "ALL", userId: target.userId });
        if (deepLinkRequest.current !== request) return;
        const found = result.kind === "ok" && result.data.items.some((candidate) => candidate.id === target.userId);
        finishOperationDeepLink(target, found);
        if (!found) return;
        setSelectedUserId(target.userId);
        setActiveSection("students");
        return;
      }
      case "audit": {
        const result = await fetchAdminAuditActions({ action: "ALL", actionId: target.actionId, query: "" });
        if (deepLinkRequest.current !== request) return;
        const action = result.kind === "ok"
          ? result.data.items.find((candidate) => candidate.id === target.actionId) ?? null
          : null;
        finishOperationDeepLink(target, action !== null);
        if (action === null) return;
        setOperationAuditAction(action);
        setActiveSection("audit");
        return;
      }
    }
  }

  function finishOperationDeepLink(target: AdminConsoleDeepLinkTarget, found: boolean): void {
    const resolution = resolveAdminConsoleDeepLink(window.location.search, (candidate) => (
      sameAdminConsoleTarget(candidate, target) && found
    ));
    if (resolution.kind === "found" || resolution.kind === "missing") {
      replaceReservationDeepLinkSearch(window.location, window.history, resolution.cleanedSearch);
    }
    if (!found) {
      setToast("관련 운영 기록을 찾을 수 없습니다.");
    }
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

  async function bulkCancelReservations(
    input: BulkCancellationInput
  ): Promise<AdminMutationResult<BulkCancellationData>> {
    const result = await bulkCancelAdminReservations(input);
    if (input.mode === "execute") {
      applyFeedback(bulkCancellationFeedback(result));
    }
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

  function setRestrictionDraft(userId: string, patch: Partial<UserRestrictionDraft>): void {
    setRestrictionDrafts((current) => patchRestrictionDrafts(current, userId, patch));
  }

  return {
    activeSection,
    auditActionFilter,
    auditActions: prependExact(reads.auditActions, operationAuditAction),
    auditExportUrl: buildAdminAuditExportUrl({ action: auditActionFilter, query: auditQuery }),
    auditFocusId: operationAuditAction?.id ?? null,
    auditPagination: reads.auditPagination,
    auditQuery,
    applyRestriction,
    applyShadowBan,
    bulkCancelReservations,
    cancelReservation,
    clearSelectedUser,
    consumeDeepLinkCancellation: () => setDeepLinkCancellation(null),
    dashboardPeriods: reads.dashboardPeriods,
    date,
    deepLinkCancellation,
    markNoShow,
    notificationBacklog: reads.notificationBacklog,
    notificationSettings: reads.notificationSettings,
    loadMoreAudit: reads.loadMoreAudit,
    loadMoreReservations: reads.loadMoreReservations,
    loadMoreUsers: reads.loadMoreUsers,
    operations,
    periods: reads.periods,
    refresh,
    reconcileNotification,
    repairOperation,
    navigateToOperationTarget,
    removeRestriction,
    reservationPeriodFilter,
    reservationQuery,
    reservationExportUrl: buildAdminReservationExportUrl({
      date,
      query: reservationQuery,
      status: statusFilter,
      studyPeriod: reservationPeriodFilter
    }),
    reservationFocusId: operationReservation?.id ?? null,
    reservationPagination: reads.reservationPagination,
    reservations: prependExact(reads.reservations, operationReservation),
    restrictionDrafts,
    saveSettings,
    restartAuditTraversal: reads.restartAuditTraversal,
    restartReservationTraversal: reads.restartReservationTraversal,
    restartUserTraversal: reads.restartUserTraversal,
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
    toast: reads.error ?? operationsError ?? toast,
    updateNotificationSettings,
    updatePeriod,
    userQuery,
    userStatusFilter,
    users: reads.users,
    userPagination: reads.userPagination,
    viewUser
  };
}

function sameDeepLinkTarget(left: DeepLinkTarget, right: DeepLinkTarget): boolean {
  return left.date === right.date && left.reservationId === right.reservationId;
}

function sameAdminConsoleTarget(left: AdminConsoleDeepLinkTarget, right: AdminConsoleDeepLinkTarget): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "reservation": return right.kind === "reservation" && left.reservationId === right.reservationId;
    case "user": return right.kind === "user" && left.userId === right.userId;
    case "audit": return right.kind === "audit" && left.actionId === right.actionId;
  }
}

function prependExact<T extends { readonly id: string }>(items: readonly T[], exact: T | null): readonly T[] {
  return exact === null ? items : [exact, ...items.filter((item) => item.id !== exact.id)];
}

function operationRepairSuccessLabel(action: AdminOperationRepairAction): string {
  switch (action) {
    case "verify_remote": return "원격 메시지 확인을 반영했습니다.";
    case "retry": return "작업을 다시 대기열에 넣었습니다.";
    case "sync": return "메시지 동기화를 요청했습니다.";
    case "remove_controls": return "Discord 컨트롤 제거를 요청했습니다.";
    case "abandon": return "운영 작업을 종료했습니다.";
  }
}

function reservationStatusFilter(status: string): AdminReservationStatusFilter {
  switch (status) {
    case "CANCELLED": return "CANCELLED";
    case "CONFIRMED": return "CONFIRMED";
    case "NO_SHOW": return "NO_SHOW";
    default: return "ALL";
  }
}
