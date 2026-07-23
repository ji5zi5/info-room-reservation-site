"use client";

import { Ban, CalendarCheck } from "lucide-react";
import type { ReactElement } from "react";

import { SHADOW_BAN_PROFILES, shadowBanProfileLabel } from "@/lib/shadow-ban-profile";
import type { UserRestrictionDraft } from "./admin-console-state";

const DAY_PRESETS = ["7", "14", "30"] as const;

type AdminStudentRestrictionFormProps = {
  readonly draft: UserRestrictionDraft;
  readonly onApply: () => void;
  readonly onSetDraft: (patch: Partial<UserRestrictionDraft>) => void;
};

export function AdminStudentRestrictionForm({
  draft,
  onApply,
  onSetDraft
}: AdminStudentRestrictionFormProps): ReactElement {
  const reasonReady = draft.reason.trim().length > 0;

  return (
    <section className="restriction-form" aria-label="학생 제재 적용">
      <label className="field">
        <span>제재 사유</span>
        <input
          required
          placeholder="사유를 입력하세요"
          value={draft.reason}
          onChange={(event) => onSetDraft({ reason: event.currentTarget.value })}
        />
      </label>
      <fieldset className="restriction-duration-presets" aria-label="제재 기간">
        <legend>제재 기간</legend>
        {DAY_PRESETS.map((days) => (
          <button
            data-active={draft.status === "RESTRICTED" && draft.days === days}
            key={days}
            className="ghost-button"
            type="button"
            onClick={() => onSetDraft({ days, status: "RESTRICTED" })}
          >
            <CalendarCheck size={16} />
            {days}일
          </button>
        ))}
        <button
          data-active={draft.status === "BANNED"}
          className="ghost-button"
          type="button"
          onClick={() => onSetDraft({ days: "", status: "BANNED" })}
        >
          <Ban size={16} />
          영구
        </button>
        <button
          data-active={draft.status === "SHADOW_BANNED"}
          className="ghost-button"
          type="button"
          onClick={() => onSetDraft({ days: "", status: "SHADOW_BANNED" })}
        >
          <Ban size={16} />
          블랙리스트(숨김)
        </button>
      </fieldset>
      {draft.status === "SHADOW_BANNED" ? (
        <fieldset className="restriction-duration-presets shadow-ban-profile-presets" aria-label="블랙리스트 강도">
          <legend>강도</legend>
          {SHADOW_BAN_PROFILES.map((profile) => (
            <button
              data-active={draft.shadowBanProfile === profile}
              key={profile}
              className="ghost-button"
              type="button"
              onClick={() => onSetDraft({ shadowBanProfile: profile })}
            >
              {shadowBanProfileLabel(profile)}
            </button>
          ))}
        </fieldset>
      ) : null}
      <button className="danger-button" disabled={!reasonReady} type="button" onClick={onApply}>
        <Ban size={16} />
        학생 제재 적용
      </button>
    </section>
  );
}
