"use client";

import { Ban, CalendarCheck } from "lucide-react";
import type { ReactElement } from "react";

import type { UserRestrictionDraft } from "./admin-console-state";

const REASON_OPTIONS = [
  { label: "미출석", value: "미출석" },
  { label: "예약 취소", value: "예약 취소" },
  { label: "관리자 확인", value: "관리자 확인" },
  { label: "직접 작성", value: "CUSTOM" }
] as const;
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
    <section className="restriction-form" aria-label="예약 제재 적용">
      <label className="field">
        <span>사유 선택</span>
        <select value={reasonSelectValue(draft.reason)} onChange={(event) => onSetDraft({ reason: parseReasonValue(event.currentTarget.value) })}>
          {REASON_OPTIONS.map((reason) => (
            <option key={reason.value} value={reason.value}>{reason.label}</option>
          ))}
        </select>
      </label>
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
      <button className="danger-button" disabled={!reasonReady} type="button" onClick={onApply}>
        <Ban size={16} />
        제재 적용
      </button>
    </section>
  );
}

function reasonSelectValue(reason: string): string {
  switch (reason) {
    case "미출석":
    case "예약 취소":
    case "관리자 확인":
      return reason;
    default:
      return "CUSTOM";
  }
}

function parseReasonValue(value: string): string {
  switch (value) {
    case "미출석":
    case "예약 취소":
    case "관리자 확인":
      return value;
    default:
      return "";
  }
}
