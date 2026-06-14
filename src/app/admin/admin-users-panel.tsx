"use client";

import { ShieldCheck } from "lucide-react";

import { parseAdminUserStatusFilter } from "@/lib/admin-users";

import { ADMIN_USER_STATUS_FILTERS, type AdminUser, type AdminUserStatusFilter } from "./admin-types";

const USER_STATUS_LABELS: Record<AdminUserStatusFilter, string> = {
  ACTIVE: "정상",
  ALL: "전체",
  BANNED: "차단",
  RESTRICTED: "제한"
};

export function AdminUsersPanel({
  onSelectUser,
  onSetQuery,
  onSetStatus,
  query,
  selectedUserId,
  status,
  users
}: {
  readonly onSelectUser: (userId: string) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onSetStatus: (status: AdminUserStatusFilter) => void;
  readonly query: string;
  readonly selectedUserId: string | null;
  readonly status: AdminUserStatusFilter;
  readonly users: readonly AdminUser[];
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>학생 관리</h2>
        </div>
        <ShieldCheck aria-hidden="true" size={22} />
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
              <strong>{user.name}</strong>
              <p className="muted">{user.studentNumber} · {user.generation}기</p>
            </div>
            <div className="user-line-summary">
              <span className="status-chip" data-status={user.bookingStatus}>{statusLabel(user.bookingStatus)}</span>
              <p className="muted">{user.restrictionReason ?? "제재 없음"}</p>
            </div>
            <button className="ghost-button" type="button" onClick={() => onSelectUser(user.id)}>
              상세 보기
            </button>
          </div>
        ))}
        {users.length === 0 ? <div className="table-line muted">검색된 학생이 없습니다.</div> : null}
      </div>
    </section>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "ACTIVE":
      return "정상";
    case "BANNED":
      return "차단";
    case "RESTRICTED":
      return "제한";
    default:
      return status;
  }
}
