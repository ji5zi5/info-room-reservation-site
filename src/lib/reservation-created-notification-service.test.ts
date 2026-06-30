import { describe, expect, it, vi } from "vitest";

import { buildReservationCreatedDiscordPayload } from "./discord-notifications";
import { defaultNotificationSettings } from "./notification-settings";
import { sendReservationCreatedNotification } from "./reservation-created-notification-service";
import type { Reservation } from "./reservation-service";

const reservation = {
  date: "2026-06-17",
  id: "reservation-secret-id",
  reason: "과제",
  status: "CONFIRMED",
  studyPeriod: "EIGHTH",
  userId: "student-1"
} satisfies Reservation;

const user = {
  name: "엄지오",
  studentNumber: "31001"
};

describe("reservation-created Discord notifications", () => {
  it("builds a payload without mentions or internal reservation ids", () => {
    const payload = buildReservationCreatedDiscordPayload({
      date: reservation.date,
      reason: reservation.reason,
      studentName: user.name,
      studentNumber: user.studentNumber,
      studyPeriod: reservation.studyPeriod
    });

    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(JSON.stringify(payload)).toContain(user.studentNumber);
    expect(JSON.stringify(payload)).toContain("과제");
    expect(JSON.stringify(payload)).not.toContain(reservation.id);
  });

  it("skips when reservation-created notifications are disabled", async () => {
    const sender = vi.fn(async () => ({ messageIds: ["discord-1"] }));

    await expect(
      sendReservationCreatedNotification({
        notificationSettings: defaultNotificationSettings(),
        reservation,
        sender,
        user,
        webhookUrl: "https://discord.com/api/webhooks/1/token"
      })
    ).resolves.toEqual({ kind: "skipped", reason: "disabled" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("returns a redacted failure instead of throwing", async () => {
    const sender = vi.fn(async () => {
      throw new Error("failed https://discord.com/api/webhooks/1/sensitive-token");
    });

    await expect(
      sendReservationCreatedNotification({
        notificationSettings: {
          ...defaultNotificationSettings(),
          reservationCreatedNotificationsEnabled: true
        },
        reservation,
        sender,
        user,
        webhookUrl: "https://discord.com/api/webhooks/1/token"
      })
    ).resolves.toEqual({
      kind: "failed",
      message: "failed https://discord.com/api/webhooks/1/[redacted]"
    });
  });
});
