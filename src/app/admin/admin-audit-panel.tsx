"use client";

import { ClipboardList, ShieldAlert, UserSearch } from "lucide-react";
import type { ReactElement } from "react";

import { parseAdminAuditActionFilter } from "@/lib/admin-audit-actions";

import { buildAuditActionsCsv } from "./admin-csv";
import { ADMIN_AUDIT_ACTION_FILTERS, type AdminAuditAction, type AdminAuditActionFilter } from "./admin-types";

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

const ACTION_LABELS: Record<string, string> = {
  ADMIN_RESERVATION_CANCEL: "관리자 예약 취소",
  CLOSED_LIST_NOTIFICATION_SEND: "마감 명단 전송",
  NO_SHOW_BAN: "노쇼 차단",
  PERIOD_SETTINGS_PATCH: "운영 설정 변경",
  STUDENT_RESERVATION_CANCEL_RESTRICTION: "학생 예약 취소 제한",
  USER_RESTRICTION_APPLY: "학생 제재 적용",
  USER_RESTRICTION_REMOVE: "학생 제재 해제",
  USER_SESSIONS_REVOKE: "학생 세션 종료"
};

export function AdminAuditPanel({
  actionFilter,
  actions,
  onSetActionFilter,
  onSetQuery,
  onViewUser,
  query
}: {
  readonly actionFilter: AdminAuditActionFilter;
  readonly actions: readonly AdminAuditAction[];
  readonly onSetActionFilter: (filter: AdminAuditActionFilter) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onViewUser: (userId: string) => void;
  readonly query: string;
}): ReactElement {
  async function copyAuditCsv(): Promise<void> {
    await navigator.clipboard.writeText(buildAuditActionsCsv(actions));
  }

  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>감사 로그</h2>
        </div>
        <div className="admin-action-row">
          <button className="ghost-button" type="button" onClick={() => void copyAuditCsv()}>
            <ClipboardList size={18} />
            감사 복사
          </button>
          <ShieldAlert aria-hidden="true" size={22} />
        </div>
      </div>
      <div className="admin-row">
        <label className="field grow-field">
          <span>학생, 관리자, 사유 검색</span>
          <input value={query} onChange={(event) => onSetQuery(event.currentTarget.value)} />
        </label>
        <label className="field">
          <span>분류</span>
          <select value={actionFilter} onChange={(event) => onSetActionFilter(parseAdminAuditActionFilter(event.currentTarget.value))}>
            {ADMIN_AUDIT_ACTION_FILTERS.map((filter) => (
              <option key={filter} value={filter}>{FILTER_LABELS[filter]}</option>
            ))}
          </select>
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
          return (
            <article className="audit-line" key={action.id}>
              <div>
                <span className="status-chip">{FILTER_LABELS[action.category]}</span>
                <strong>{ACTION_LABELS[action.action] ?? action.action}</strong>
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
    </section>
  );
}

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
