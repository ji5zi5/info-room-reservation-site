"use client";

import { Ban, ShieldOff, UserX } from "lucide-react";
import type { ReactElement } from "react";

import type { AdminUser } from "./admin-types";

export function AdminBlacklistPanel({
  onRelease,
  onSelectUser,
  onSetQuery,
  onShadowBan,
  query,
  selectedUserId,
  users
}: {
  readonly onRelease: (userId: string) => void;
  readonly onSelectUser: (userId: string) => void;
  readonly onSetQuery: (q: string) => void;
  readonly onShadowBan: (userId: string) => void;
  readonly query: string;
  readonly selectedUserId: string | null;
  readonly users: readonly AdminUser[];
}): ReactElement {
  const shadowBannedUsers = users.filter((u) => u.bookingStatus === "SHADOW_BANNED");
  const normalUsers = users.filter((u) => u.bookingStatus !== "SHADOW_BANNED");
  const filteredNormal = query.trim()
    ? normalUsers.filter(
        (u) =>
          u.name.toLocaleLowerCase("ko-KR").includes(query.trim().toLocaleLowerCase("ko-KR")) ||
          u.studentNumber.toLocaleLowerCase("ko-KR").includes(query.trim().toLocaleLowerCase("ko-KR"))
      )
    : [];

  return (
    <section className="admin-panel stack">
      <div className="topbar">
        <div>
          <h2>블랙리스트 관리</h2>
        </div>
      </div>

      <div className="bl-section">
        <div className="bl-section-head">
          <UserX size={15} />
          <h3>
            현재 블랙리스트
            <span className="bl-count">{shadowBannedUsers.length}명</span>
          </h3>
        </div>
        <div className="blacklist-grid">
          {shadowBannedUsers.length === 0 ? (
            <div className="bl-empty">블랙리스트에 등록된 학생이 없습니다.</div>
          ) : (
            shadowBannedUsers.map((user) => (
              <div className="bl-card bl-card--active" key={user.id} data-selected={selectedUserId === user.id}>
                <div className="bl-card-info">
                  <strong>{user.name}</strong>
                  <span className="muted">{user.studentNumber} · {user.generation}기</span>
                  {user.restrictionReason ? (
                    <span className="bl-reason">{user.restrictionReason}</span>
                  ) : null}
                </div>
                <div className="bl-card-actions">
                  <button className="ghost-button" type="button" onClick={() => onSelectUser(user.id)}>
                    상세
                  </button>
                  <button className="primary-button" type="button" onClick={() => onRelease(user.id)}>
                    <ShieldOff size={14} />
                    해제
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="bl-section">
        <div className="bl-section-head">
          <Ban size={15} />
          <h3>학생 검색하여 추가</h3>
        </div>
        <label className="field">
          <span>이름 또는 학번</span>
          <input
            id="blacklist-user-search"
            placeholder="검색어를 입력하세요"
            type="search"
            value={query}
            onChange={(e) => onSetQuery(e.currentTarget.value)}
          />
        </label>
        <div className="blacklist-grid">
          {query.trim() === "" ? (
            <div className="bl-empty">이름 또는 학번을 검색하면 학생 목록이 표시됩니다.</div>
          ) : filteredNormal.length === 0 ? (
            <div className="bl-empty">검색 결과가 없습니다.</div>
          ) : (
            filteredNormal.slice(0, 20).map((user) => (
              <div className="bl-card" key={user.id} data-selected={selectedUserId === user.id}>
                <div className="bl-card-info">
                  <strong>{user.name}</strong>
                  <span className="muted">{user.studentNumber} · {user.generation}기</span>
                  <span className="status-chip" data-status={user.bookingStatus}>
                    {bookingStatusLabel(user.bookingStatus)}
                  </span>
                </div>
                <div className="bl-card-actions">
                  <button className="ghost-button" type="button" onClick={() => onSelectUser(user.id)}>
                    상세
                  </button>
                  <button className="danger-button" type="button" onClick={() => onShadowBan(user.id)}>
                    <Ban size={14} />
                    블랙리스트
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function bookingStatusLabel(status: string): string {
  switch (status) {
    case "ACTIVE": return "정상";
    case "BANNED": return "차단";
    case "RESTRICTED": return "제한";
    case "SHADOW_BANNED": return "블랙리스트(숨김)";
    default: return status;
  }
}
