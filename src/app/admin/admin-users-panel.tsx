"use client";

import { Ban, ShieldCheck } from "lucide-react";

import { parseAdminUserStatusFilter } from "@/lib/admin-users";

import { ADMIN_USER_STATUS_FILTERS, type AdminUser, type AdminUserStatusFilter } from "./admin-types";

const USER_STATUS_LABELS: Record<AdminUserStatusFilter, string> = {
  ACTIVE: "정상",
  ALL: "전체",
  BANNED: "차단",
  RESTRICTED: "제한"
};

export function AdminUsersPanel({
  onApplyRestriction,
  onRemoveRestriction,
  onSetDraft,
  onSetQuery,
  onSetStatus,
  query,
  restrictionDrafts,
  status,
  users
}: {
  readonly onApplyRestriction: (userId: string) => void;
  readonly onRemoveRestriction: (userId: string) => void;
  readonly onSetDraft: (userId: string, patch: { readonly days?: string; readonly reason?: string; readonly status?: "BANNED" | "RESTRICTED" }) => void;
  readonly onSetQuery: (query: string) => void;
  readonly onSetStatus: (status: AdminUserStatusFilter) => void;
  readonly query: string;
  readonly restrictionDrafts: Readonly<Record<string, { readonly days: string; readonly reason: string; readonly status: "BANNED" | "RESTRICTED" }>>;
  readonly status: AdminUserStatusFilter;
  readonly users: readonly AdminUser[];
}): React.ReactElement {
  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>학생 관리</h2>
          <p className="muted">검색 · 예약 제한 · 제한 해제</p>
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
        {users.map((user) => {
          const draft = restrictionDrafts[user.id] ?? { days: "7", reason: "정보실 예약 제한", status: "RESTRICTED" };
          return (
            <div className="user-line" key={user.id}>
              <div>
                <strong>{user.name}</strong>
                <p className="muted">{user.studentNumber} · {statusLabel(user.bookingStatus)}</p>
                {user.restrictionReason ? <p className="muted">{user.restrictionReason}</p> : null}
              </div>
              <div className="restriction-controls">
                <select value={draft.status} onChange={(event) => onSetDraft(user.id, { status: parseRestrictionStatus(event.currentTarget.value) })}>
                  <option value="RESTRICTED">기간 제한</option>
                  <option value="BANNED">차단</option>
                </select>
                <input value={draft.days} onChange={(event) => onSetDraft(user.id, { days: event.currentTarget.value })} />
                <input value={draft.reason} onChange={(event) => onSetDraft(user.id, { reason: event.currentTarget.value })} />
                <button className="danger-button" type="button" onClick={() => onApplyRestriction(user.id)}>
                  <Ban size={16} />
                  제한
                </button>
                {user.bookingStatus !== "ACTIVE" ? (
                  <button className="ghost-button" type="button" onClick={() => onRemoveRestriction(user.id)}>
                    해제
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {users.length === 0 ? <div className="table-line muted">검색된 학생이 없습니다.</div> : null}
      </div>
    </section>
  );
}

function parseRestrictionStatus(value: string): "BANNED" | "RESTRICTED" {
  switch (value) {
    case "BANNED":
      return "BANNED";
    case "RESTRICTED":
    default:
      return "RESTRICTED";
  }
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
