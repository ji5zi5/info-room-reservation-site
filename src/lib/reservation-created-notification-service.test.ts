import { describe, expect, it, vi } from "vitest";

import type { DiscordWebhookPayload } from "./discord-notifications";
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

const applicant = {
  name: "엄지오",
  studentNumber: "31001"
} as const;

describe("reservation-created Discord notifications", () => {
  it("passes the applicant and reservation reason into the Discord payload", async () => {
    const sender = vi.fn(async (_payload: DiscordWebhookPayload) => ({ messageIds: ["discord-1"] }));
    const embedTitleUrl =
      "https://example.test/admin?section=reservations&date=2026-06-17&status=CONFIRMED&reservation=reservation-secret-id";

    await sendReservationCreatedNotification({
      applicant,
      embedTitleUrl,
      notificationSettings: {
        ...defaultNotificationSettings(),
        reservationCreatedNotificationsEnabled: true
      },
      reservation,
      sender,
      webhookUrl: "https://discord.com/api/webhooks/1/token"
    });

    const serialized = JSON.stringify(sender.mock.calls[0]?.[0]);

    expect(serialized).toContain(embedTitleUrl);
    expect(serialized).toContain("과제");
    expect(serialized).toContain("31001");
    expect(serialized).toContain("엄지오");
    expect(serialized).not.toContain(reservation.userId);
  });

  it("skips when reservation-created notifications are disabled", async () => {
    const sender = vi.fn(async () => ({ messageIds: ["discord-1"] }));

    await expect(
      sendReservationCreatedNotification({
        applicant,
        notificationSettings: defaultNotificationSettings(),
        reservation,
        sender,
        webhookUrl: "https://discord.com/api/webhooks/1/token"
      })
    ).resolves.toEqual({ kind: "skipped", reason: "disabled" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("skips when the Discord webhook is missing", async () => {
    const sender = vi.fn(async (_payload: DiscordWebhookPayload) => ({ messageIds: ["discord-1"] }));

    await expect(
      sendReservationCreatedNotification({
        applicant,
        notificationSettings: {
          ...defaultNotificationSettings(),
          reservationCreatedNotificationsEnabled: true
        },
        reservation,
        sender,
        webhookUrl: undefined
      })
    ).resolves.toEqual({ kind: "skipped", reason: "webhook_missing" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("returns a redacted failure instead of throwing", async () => {
    const sender = vi.fn(async () => {
      throw new Error("failed https://discord.com/api/webhooks/1/sensitive-token");
    });

    await expect(
      sendReservationCreatedNotification({
        applicant,
        notificationSettings: {
          ...defaultNotificationSettings(),
          reservationCreatedNotificationsEnabled: true
        },
        reservation,
        sender,
        webhookUrl: "https://discord.com/api/webhooks/1/token"
      })
    ).resolves.toEqual({
      kind: "failed",
      message: "failed https://discord.com/api/webhooks/1/[redacted]"
    });
  });
});
