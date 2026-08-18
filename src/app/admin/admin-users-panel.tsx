"use client";

import { ChevronDown, RotateCcw } from "lucide-react";

import { parseAdminUserStatusFilter } from "@/lib/admin-users";

import { adminAccountDescription, adminAccountName } from "./admin-account-labels";
import type { AdminPaginationState } from "./admin-console-state";
import { ADMIN_USER_STATUS_FILTERS, type AdminUser, type AdminUserStatusFilter } from "./admin-types";

const USER_STATUS_LABELS: Record<AdminUserStatusFilter, string> = {
  ACTIVE: "정상",
  ALL: "전체",
  BANNED: "차단",
  SHADOW_BANNED: "블랙리스트(숨김)",
  RESTRICTED: "제한"
};

export function AdminUsersPanel({
  onSelectUser,
  onLoadMore = noop,
  onRestartTraversal = noop,
  onSetQuery,
  onSetStatus,
  query,
  selectedUserId,
  status,
  users,
  pagination = terminalPagination(users.length)
}: {
  readonly onLoadMore?: () => void;
  readonly onRestartTraversal?: () => void;
  readonly onSelectUser: (userId: string) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onSetStatus: (status: AdminUserStatusFilter) => void;
  readonly query: string;
  readonly selectedUserId: string | null;
  readonly status: AdminUserStatusFilter;
  readonly users: readonly AdminUser[];
  readonly pagination?: AdminPaginationState;
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>학생 관리</h2>
        </div>
      </div>
      <div className="admin-row">
        <label className="field grow-field">
          <span>이름 또는 학번</span>
          <input value={query} onChange={(event) => onSetQuery(event.currentTarget.value)} />
        </label>
        <label className="field">
          <span>상태</span>
          <select value={status} onChange={(event) => onSetStatus(parseAdminUserStatusFilter(event.currentTarget.value))}>
            {ADMIN_USER_STATUS_FILTERS.map((filter) => (
              <option key={filter} value={filter}>{USER_STATUS_LABELS[filter]}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="user-list">
        {users.map((user) => (
          <div className="user-line" data-selected={selectedUserId === user.id} key={user.id}>
            <div className="user-line-main">
              <strong>{adminAccountName(user)}</strong>
              <p className="muted">{adminAccountDescription(user)}</p>
            </div>
            <div className="user-line-summary">
              <span className="status-chip" data-status={user.bookingStatus}>{statusLabel(user.bookingStatus)}</span>
              <p className="muted">{user.restrictionReason ?? "제재 없음"}</p>
            </div>
            <button
              className="ghost-button"
              type="button"
              onClick={(event) => {
                keepUserRowVisible(event.currentTarget);
                onSelectUser(user.id);
              }}
            >
              상세 보기
            </button>
          </div>
        ))}
        {users.length === 0 ? <div className="table-line muted">검색된 학생이 없습니다.</div> : null}
      </div>
      <AdminPaginationFooter
        onLoadMore={onLoadMore}
        onRestartTraversal={onRestartTraversal}
        pagination={pagination}
      />
    </section>
  );
}

export function AdminPaginationFooter({
  onLoadMore,
  onRestartTraversal,
  pagination
}: {
  readonly onLoadMore: () => void;
  readonly onRestartTraversal: () => void;
  readonly pagination: AdminPaginationState;
}): React.ReactElement {
  const terminal = pagination.nextCursor === null;
  return (
    <div className="admin-pagination-footer">
      <span aria-live="polite" className="muted">
        {pagination.hasHiddenPrevious ? "최근 " : ""}{pagination.loadedCount}개 표시 / 현재 {pagination.currentTotalCount}건
      </span>
      {pagination.restartRequired ? (
        <button className="ghost-button admin-load-more" type="button" onClick={onRestartTraversal}>
          <RotateCcw aria-hidden="true" size={16} />
          처음부터 다시
        </button>
      ) : (
        <button
          className="ghost-button admin-load-more"
          disabled={(terminal && !pagination.hasHiddenPrevious) || pagination.loadingMore}
          type="button"
          onClick={terminal && pagination.hasHiddenPrevious ? onRestartTraversal : onLoadMore}
        >
          {terminal && pagination.hasHiddenPrevious ? (
            <RotateCcw aria-hidden="true" size={16} />
          ) : (
            <ChevronDown aria-hidden="true" size={16} />
          )}
          {pagination.loadingMore
            ? "불러오는 중"
            : terminal
              ? pagination.hasHiddenPrevious ? "처음부터 보기" : "탐색 완료"
              : "더 보기"}
        </button>
      )}
    </div>
  );
}

function terminalPagination(loadedCount: number): AdminPaginationState {
  return {
    currentTotalCount: loadedCount,
    hasHiddenPrevious: false,
    loadedCount,
    loadingMore: false,
    nextCursor: null,
    restartRequired: false
  };
}

function noop(): void {}

function statusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "정상";
    case "BANNED":
      return "차단";
    case "SHADOW_BANNED":
      return "블랙리스트(숨김)";
    case "RESTRICTED":
      return "제한";
    default:
      return status;
  }
}

function keepUserRowVisible(button: HTMLButtonElement): void {
  const row = button.closest<HTMLElement>(".user-line");
  const list = button.closest<HTMLElement>(".user-list");
  if (!row || !list) {
    return;
  }
  window.requestAnimationFrame(() => {
    const rowRect = row.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    if (rowRect.top < listRect.top) {
      list.scrollTop += rowRect.top - listRect.top;
      return;
    }
    if (rowRect.bottom > listRect.bottom) {
      list.scrollTop += rowRect.bottom - listRect.bottom;
    }
  });
}
