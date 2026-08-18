import type {
  AdminAuditAction,
  AdminAuditActionFilter,
  AdminDashboardPeriod,
  AdminNotificationBacklogItem,
  AdminNotificationReconciliationAction,
  AdminNotificationSettings,
  AdminOperationItem,
  AdminOperationRepairAction,
  AdminOperationsPayload,
  AdminPeriodSetting,
  AdminReservation,
  AdminReservationStatusFilter,
  AdminReservationStudyPeriodFilter,
  AdminStatistics,
  AdminUser,
  AdminUserDetail,
  AdminUserStatusFilter,
  StudyPeriod
} from "./admin-types";
import type { AdminMutationResult, ApplyRestrictionData, BulkCancellationData, BulkCancellationInput, CancelReservationData, DiscordOperationRepairData, NoShowReservationData } from "./admin-api-client";
import type { AdminConsoleDeepLinkTarget } from "./admin-console-url";
import { DEFAULT_SHADOW_BAN_PROFILE, type ShadowBanProfile } from "@/lib/shadow-ban-profile";

export type UserRestrictionDraft = {
  readonly days: string;
  readonly reason: string;
  readonly shadowBanProfile: ShadowBanProfile;
  readonly status: "BANNED" | "RESTRICTED" | "SHADOW_BANNED";
};

export type AdminSection = "audit" | "blacklist" | "dashboard" | "reservations" | "settings" | "students";

export type AdminPaginationState = {
  readonly currentTotalCount: number;
  readonly hasHiddenPrevious: boolean;
  readonly loadedCount: number;
  readonly loadingMore: boolean;
  readonly nextCursor: string | null;
  readonly restartRequired: boolean;
};

export const DEFAULT_RESTRICTION_DRAFT = {
  days: "7",
  reason: "",
  shadowBanProfile: DEFAULT_SHADOW_BAN_PROFILE,
  status: "RESTRICTED"
} satisfies UserRestrictionDraft;

export type AdminConsoleState = {
  readonly activeSection: AdminSection;
  readonly auditActionFilter: AdminAuditActionFilter;
  readonly auditActions: readonly AdminAuditAction[];
  readonly auditExportUrl: string;
  readonly auditPagination: AdminPaginationState;
  readonly auditFocusId: string | null;
  readonly auditQuery: string;
  readonly applyRestriction: (userId: string) => Promise<AdminMutationResult<ApplyRestrictionData>>;
  readonly applyShadowBan: (userId: string) => Promise<void>;
  readonly bulkCancelReservations: (input: BulkCancellationInput) => Promise<AdminMutationResult<BulkCancellationData>>;
  readonly cancelReservation: (reservationId: string, reason: string) => Promise<AdminMutationResult<CancelReservationData>>;
  readonly clearSelectedUser: () => void;
  readonly dashboardPeriods: readonly AdminDashboardPeriod[];
  readonly date: string;
  readonly deepLinkCancellation: AdminReservation | null;
  readonly consumeDeepLinkCancellation: () => void;
  readonly markNoShow: (reservationId: string) => Promise<AdminMutationResult<NoShowReservationData>>;
  readonly notificationBacklog: readonly AdminNotificationBacklogItem[];
  readonly notificationSettings: AdminNotificationSettings;
  readonly loadMoreAudit: () => Promise<void>;
  readonly loadMoreReservations: () => Promise<void>;
  readonly loadMoreUsers: () => Promise<void>;
  readonly operations: AdminOperationsPayload | null;
  readonly periods: readonly AdminPeriodSetting[];
  readonly refresh: () => Promise<void>;
  readonly removeRestriction: (userId: string) => Promise<void>;
  readonly reservationPeriodFilter: AdminReservationStudyPeriodFilter;
  readonly reservationQuery: string;
  readonly reservationExportUrl: string;
  readonly reservationPagination: AdminPaginationState;
  readonly reservationFocusId: string | null;
  readonly reservations: readonly AdminReservation[];
  readonly restrictionDrafts: Readonly<Record<string, UserRestrictionDraft>>;
  readonly saveSettings: () => Promise<void>;
  readonly restartAuditTraversal: () => Promise<void>;
  readonly restartReservationTraversal: () => Promise<void>;
  readonly restartUserTraversal: () => Promise<void>;
  readonly selectedUserDetail: AdminUserDetail | null;
  readonly selectedUserId: string | null;
  readonly selectStatus: (status: AdminReservationStatusFilter) => void;
  readonly reconcileNotification: (
    item: AdminNotificationBacklogItem,
    action: AdminNotificationReconciliationAction
  ) => Promise<void>;
  readonly repairOperation: (
    item: AdminOperationItem,
    action: AdminOperationRepairAction
  ) => Promise<AdminMutationResult<DiscordOperationRepairData>>;
  readonly navigateToOperationTarget: (target: AdminConsoleDeepLinkTarget) => Promise<void>;
  readonly sendNotification: (period: AdminDashboardPeriod) => Promise<void>;
  readonly setActiveSection: (section: AdminSection) => void;
  readonly setAuditActionFilter: (filter: AdminAuditActionFilter) => void;
  readonly setAuditQuery: (query: string) => void;
  readonly setDate: (date: string) => void;
  readonly setReservationPeriodFilter: (period: AdminReservationStudyPeriodFilter) => void;
  readonly setReservationQuery: (query: string) => void;
  readonly setRestrictionDraft: (userId: string, patch: Partial<UserRestrictionDraft>) => void;
  readonly setUserQuery: (query: string) => void;
  readonly setUserStatusFilter: (status: AdminUserStatusFilter) => void;
  readonly statusFilter: AdminReservationStatusFilter;
  readonly statistics: AdminStatistics | null;
  readonly toast: string | null;
  readonly updateNotificationSettings: (patch: Partial<AdminNotificationSettings>) => void;
  readonly updatePeriod: (studyPeriod: StudyPeriod, patch: Partial<AdminPeriodSetting>) => void;
  readonly userQuery: string;
  readonly userStatusFilter: AdminUserStatusFilter;
  readonly users: readonly AdminUser[];
  readonly userPagination: AdminPaginationState;
  readonly viewUser: (userId: string) => Promise<void>;
};
