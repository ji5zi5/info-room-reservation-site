"use client";

import { UserPlus } from "lucide-react";
import { useState, type FormEvent, type ReactElement } from "react";

import { createAdminReservation } from "./admin-create-reservation-client";
import type { StudyPeriod } from "./admin-types";

const STUDY_PERIOD_OPTIONS: readonly { readonly label: string; readonly value: StudyPeriod }[] = [
  { label: "8면학", value: "EIGHTH" },
  { label: "1면학", value: "FIRST" }
];

type AdminReservationCreateFormProps = {
  readonly date: string;
  readonly onCreated: () => void;
};

export function AdminReservationCreateForm({ date, onCreated }: AdminReservationCreateFormProps): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("관리자 수동 추가");
  const [studentNumber, setStudentNumber] = useState("");
  const [studyPeriod, setStudyPeriod] = useState<StudyPeriod>("EIGHTH");

  const trimmedReason = reason.trim();
  const trimmedStudentNumber = studentNumber.trim();
  const canSubmit = !pending && trimmedReason.length > 0 && trimmedStudentNumber.length > 0;

  async function submitReservation(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setPending(true);
    setMessage(null);
    const result = await createAdminReservation({
      date,
      reason: trimmedReason,
      studentNumber: trimmedStudentNumber,
      studyPeriod
    });
    setPending(false);
    if (result.kind === "ok") {
      setStudentNumber("");
      setReason("관리자 수동 추가");
      setMessage("학생 예약을 추가했습니다.");
      onCreated();
      return;
    }
    setMessage(result.message);
  }

  return (
    <form aria-label="학생 예약 수동 추가" className="admin-create-reservation" onSubmit={submitReservation}>
      <div className="admin-create-reservation-head">
        <h3>학생 추가</h3>
        <span>{date}</span>
      </div>
      <div className="admin-create-reservation-grid">
        <label className="field">
          <span>학번</span>
          <input
            autoComplete="off"
            inputMode="text"
            placeholder="25001"
            value={studentNumber}
            onChange={(event) => setStudentNumber(event.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>시간대</span>
          <select value={studyPeriod} onChange={(event) => setStudyPeriod(parseStudyPeriod(event.currentTarget.value))}>
            {STUDY_PERIOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>사유</span>
          <input maxLength={80} value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
        </label>
        <button className="ghost-button admin-create-reservation-submit" disabled={!canSubmit} type="submit">
          <UserPlus size={16} />
          {pending ? "추가 중" : "추가"}
        </button>
      </div>
      {message ? <p className="admin-inline-message">{message}</p> : null}
    </form>
  );
}

function parseStudyPeriod(value: string): StudyPeriod {
  switch (value) {
    case "FIRST":
      return "FIRST";
    case "EIGHTH":
    default:
      return "EIGHTH";
  }
}
