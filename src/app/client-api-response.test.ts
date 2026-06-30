import { describe, expect, it } from "vitest";

import type { StudentProfilePayload } from "@/lib/student-profile";
import { readStudentNotificationsPayload, readStudentProfilePayload } from "./client-api-response";

const profileFixture = {
  currentReservations: [
    {
      createdAt: "2026-06-15T04:00:00.000Z",
      date: "2026-06-16",
      status: "CONFIRMED",
      studyPeriod: "EIGHTH",
      updatedAt: "2026-06-15T04:00:00.000Z"
    }
  ],
  effectiveStatus: "ACTIVE",
  recentReservations: [
    {
      createdAt: "2026-06-14T04:00:00.000Z",
      date: "2026-06-14",
      status: "CANCELLED",
      studyPeriod: "FIRST",
      updatedAt: "2026-06-14T05:00:00.000Z"
    }
  ],
  recentSanctions: [
    {
      createdAt: "2026-06-14T05:00:00.000Z",
      endsAt: null,
      reason: "예약 취소",
      revokedAt: null,
      startsAt: "2026-06-14T05:00:00.000Z",
      status: "ACTIVE",
      type: "CANCEL_RESTRICTION"
    }
  ],
  reservationSummary: {
    cancelledCount: 1,
    confirmedCount: 1,
    noShowCount: 0
  },
  sanctionSummary: {
    activeCount: 1,
    permanentCount: 1,
    revokedCount: 0,
    totalCount: 1
  },
  statusMessage: "예약 가능",
  user: {
    bookingStatus: "ACTIVE",
    generation: 12,
    name: "김학생",
    restrictionReason: null,
    restrictedUntil: null,
    role: "STUDENT",
    studentNumber: "1201"
  }
} satisfies StudentProfilePayload;

describe("readStudentProfilePayload", () => {
  it("returns a loaded profile when the response contains a valid student profile", async () => {
    // Given
    const response = jsonResponse(profileFixture);

    // When
    const result = await readStudentProfilePayload(response);

    // Then
    expect(result).toEqual({ kind: "loaded", profile: profileFixture });
  });

  it("returns a recoverable error when the response is empty 204", async () => {
    // Given
    const response = new Response(null, { status: 204 });

    // When
    const result = await readStudentProfilePayload(response);

    // Then
    expect(result).toEqual({ kind: "error", message: "프로필 응답이 비어 있습니다." });
  });

  it("returns a recoverable error when the response body is malformed JSON", async () => {
    // Given
    const response = new Response("{not-json", { status: 200 });

    // When
    const result = await readStudentProfilePayload(response);

    // Then
    expect(result).toEqual({ kind: "error", message: "프로필 응답을 읽을 수 없습니다." });
  });

  it("returns a server error message when a non-OK response contains JSON error details", async () => {
    // Given
    const response = jsonResponse({ error: { message: "로그인이 필요합니다." } }, { status: 401 });

    // When
    const result = await readStudentProfilePayload(response);

    // Then
    expect(result).toEqual({ kind: "error", message: "로그인이 필요합니다." });
  });
});

describe("readStudentNotificationsPayload", () => {
  it("returns loaded notifications when the response contains valid student notifications", async () => {
    // Given
    const notifications = [
      {
        createdAt: "2026-06-16T04:30:00.000Z",
        id: "action-cancel",
        message: "2026-06-17 8면학 신청이 취소되었습니다.",
        title: "관리자 취소 안내"
      }
    ] as const;
    const response = jsonResponse({ notifications });

    // When
    const result = await readStudentNotificationsPayload(response);

    // Then
    expect(result).toEqual({ kind: "loaded", notifications });
  });

  it("returns a recoverable error when the notification response has the wrong shape", async () => {
    // Given
    const response = jsonResponse({ notifications: [{ id: "missing-fields" }] });

    // When
    const result = await readStudentNotificationsPayload(response);

    // Then
    expect(result).toEqual({ kind: "error", message: "알림 응답 형식이 올바르지 않습니다." });
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init
  });
}
