"use client";

import { Download, UserSearch } from "lucide-react";
import { useEffect, useRef, type ReactElement } from "react";

import { getAdminAuditActionLabel } from "@/lib/admin-audit-actions";

import type { AdminPaginationState } from "./admin-console-state";
import { ADMIN_AUDIT_ACTION_FILTERS, type AdminAuditAction, type AdminAuditActionFilter } from "./admin-types";
import { AdminPaginationFooter } from "./admin-users-panel";

const FILTER_LABELS: Record<AdminAuditActionFilter, string> = {
  ALL: "전체",
  NO_SHOW: "노쇼",
  NOTIFICATION: "알림",
  OTHER: "기타",
  RESERVATION: "예약",
  RESTRICTION: "제재",
  SESSION: "세션",
  SETTINGS: "설정"
};

export function AdminAuditPanel({
  actionFilter,
  actions,
  exportUrl,
  focusRecordId = null,
  onLoadMore = noop,
  onRestartTraversal = noop,
  onSetActionFilter,
  onSetQuery,
  onViewUser,
  query,
  pagination = terminalPagination(actions.length)
}: {
  readonly actionFilter: AdminAuditActionFilter;
  readonly actions: readonly AdminAuditAction[];
  readonly exportUrl: string;
  readonly focusRecordId?: string | null;
  readonly onLoadMore?: () => void;
  readonly onRestartTraversal?: () => void;
  readonly onSetActionFilter: (filter: AdminAuditActionFilter) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onViewUser: (userId: string) => void;
  readonly pagination?: AdminPaginationState;
  readonly query: string;
}): ReactElement {
  const focusRowRef = useRef<HTMLElement>(null);

  useEffect(() => {
    focusRowRef.current?.focus();
  }, [actions, focusRecordId]);

  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>감사 로그</h2>
        </div>
        <div className="admin-action-row">
          <a className="ghost-button" href={exportUrl}>
            <Download aria-hidden="true" size={18} />
            CSV 다운로드
          </a>
        </div>
      </div>
      <div className="admin-row">
        <label className="field grow-field">
          <span>학생, 관리자, 사유 검색</span>
          <input value={query} onChange={(event) => onSetQuery(event.currentTarget.value)} />
        </label>
      </div>
      <div className="status-filter" aria-label="감사 로그 분류">
        {ADMIN_AUDIT_ACTION_FILTERS.map((filter) => (
          <button data-active={actionFilter === filter} key={filter} type="button" onClick={() => onSetActionFilter(filter)}>
            {FILTER_LABELS[filter]}
          </button>
        ))}
      </div>
      <div className="audit-list">
        {actions.map((action) => {
          const targetUser = action.targetUser;
          const focusTarget = action.id === focusRecordId;
          return (
            <article
              className="audit-line"
              data-focus-target={focusTarget ? "true" : undefined}
              key={action.id}
              ref={focusTarget ? focusRowRef : undefined}
              tabIndex={focusTarget ? -1 : undefined}
            >
              <div>
                <span className="status-chip">{FILTER_LABELS[action.category]}</span>
                <strong>{getAdminAuditActionLabel(action.action)}</strong>
                <p className="muted">{formatDateTime(action.createdAt)}</p>
              </div>
              <div className="detail-lines">
                <div className="detail-line">
                  <span>대상</span>
                  <strong>{formatPerson(targetUser)}</strong>
                </div>
                <div className="detail-line">
                  <span>처리자</span>
                  <strong>{formatPerson(action.actor)}</strong>
                </div>
                <div className="detail-line">
                  <span>사유</span>
                  <strong>{action.reason ?? "기록 없음"}</strong>
                </div>
              </div>
              <div className="admin-action-row">
                {targetUser ? (
                  <button className="ghost-button" type="button" onClick={() => onViewUser(targetUser.id)}>
                    <UserSearch size={16} />
                    학생 보기
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {actions.length === 0 ? <div className="table-line muted">표시할 감사 로그가 없습니다.</div> : null}
      </div>
      <AdminPaginationFooter
        onLoadMore={onLoadMore}
        onRestartTraversal={onRestartTraversal}
        pagination={pagination}
      />
    </section>
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

function formatPerson(person: AdminAuditAction["actor"]): string {
  return person ? `${person.name} (${person.studentNumber})` : "기록 없음";
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}
