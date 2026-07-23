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

describe("reservation-created Discord notifications", () => {
  it("builds a payload without student identity or free-text reason", () => {
    const payloadInput = {
      date: reservation.date,
      reservationId: reservation.id,
      studyPeriod: reservation.studyPeriod
    } as const;
    const payload = buildReservationCreatedDiscordPayload(payloadInput);
    const serialized = JSON.stringify(payload);

    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(serialized).toContain(reservation.id);
    expect(serialized).not.toContain("과제");
  });

  it("skips when reservation-created notifications are disabled", async () => {
    const sender = vi.fn(async () => ({ messageIds: ["discord-1"] }));

    await expect(
      sendReservationCreatedNotification({
        notificationSettings: defaultNotificationSettings(),
        reservation,
        sender,
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
        webhookUrl: "https://discord.com/api/webhooks/1/token"
      })
    ).resolves.toEqual({
      kind: "failed",
      message: "failed https://discord.com/api/webhooks/1/[redacted]"
    });
  });
});
