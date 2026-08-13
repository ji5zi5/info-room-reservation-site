import { describe, expect, it } from "vitest";

import {
  buildStudentNotificationPresentation,
  buildStudentNotifications
} from "./student-notifications";

describe("student notifications", () => {
  it("builds a student-facing notification from an admin reservation cancellation", () => {
    // Given
    const rows = [
      {
        action: "ADMIN_RESERVATION_CANCEL",
        createdAt: new Date("2026-06-16T04:30:00.000Z"),
        id: "action-cancel",
        reason: "행사 준비로 정보실 사용 불가",
        reservation: { date: "2026-06-17", studyPeriod: "EIGHTH" }
      }
    ] as const;

    // When
    const notifications = buildStudentNotifications(rows);

    // Then
    expect(notifications).toEqual([
      {
        createdAt: "2026-06-16T04:30:00.000Z",
        id: "action-cancel",
        message: "2026-06-17 8면학 신청이 취소되었습니다.",
        reason: "행사 준비로 정보실 사용 불가",
        title: "관리자 취소 안내"
      }
    ]);
  });

  it("does not expose unrelated admin actions as student notifications", () => {
    // Given
    const rows = [
      {
        action: "USER_RESTRICTION_APPLY",
        createdAt: new Date("2026-06-16T04:30:00.000Z"),
        id: "action-restriction",
        reason: "관리자 확인",
        reservation: null
      }
    ] as const;

    // When
    const notifications = buildStudentNotifications(rows);

    // Then
    expect(notifications).toEqual([]);
  });

  it("returns only the five most recent matching notifications", () => {
    // Given
    const rows = Array.from({ length: 7 }, (_, index) => ({
      action: "ADMIN_RESERVATION_CANCEL",
      createdAt: new Date(`2026-06-${String(10 + index).padStart(2, "0")}T04:30:00.000Z`),
      id: `action-${index}`,
      reason: null,
      reservation: { date: "2026-06-17", studyPeriod: "EIGHTH" }
    })).reverse();

    // When
    const notifications = buildStudentNotifications(rows);
    const presentation = buildStudentNotificationPresentation({ kind: "loaded", notifications });

    // Then
    expect(notifications.map(({ id }) => id)).toEqual([
      "action-6",
      "action-5",
      "action-4",
      "action-3",
      "action-2"
    ]);
    expect(presentation).toMatchObject({ count: 5, kind: "ready", notifications });
  });

  it("presents loading and empty notification lists without a hidden count", () => {
    // Given / When
    const loading = buildStudentNotificationPresentation({ kind: "loading" });
    const empty = buildStudentNotificationPresentation({ kind: "loaded", notifications: [] });

    // Then
    expect(loading).toEqual({ count: 0, kind: "loading", notifications: [] });
    expect(empty).toEqual({ count: 0, kind: "empty", notifications: [] });
  });

  it("presents a stale notification list as the bounded list rendered and counted", () => {
    // Given
    const notifications = Array.from({ length: 7 }, (_, index) => ({
      createdAt: new Date(2026, 5, 10 + index).toISOString(),
      id: `notification-${index}`,
      message: "예약이 취소되었습니다.",
      reason: null,
      title: "관리자 취소 안내"
    }));

    // When
    const presentation = buildStudentNotificationPresentation({ kind: "stale", notifications });

    // Then
    expect(presentation.kind).toBe("stale");
    expect(presentation.count).toBe(5);
    expect(presentation.notifications.map(({ id }) => id)).toEqual([
      "notification-6",
      "notification-5",
      "notification-4",
      "notification-3",
      "notification-2"
    ]);
  });

  it("does not expose peer identity or shadow-ban fields in notification results", () => {
    // Given
    const row = {
      action: "ADMIN_RESERVATION_CANCEL",
      createdAt: new Date("2026-06-16T04:30:00.000Z"),
      id: "action-cancel",
      peerApplicant: { name: "다른 학생" },
      reason: null,
      reservation: { date: "2026-06-17", studyPeriod: "FIRST" },
      shadowBanProfile: { bookingStatus: "SHADOW_BANNED" }
    };

    // When
    const [notification] = buildStudentNotifications([row]);

    // Then
    expect(Object.keys(notification ?? {}).sort()).toEqual(["createdAt", "id", "message", "reason", "title"]);
  });
});
