import {
  buildReservationCreatedDiscordPayload,
  redactDiscordWebhookTokens,
  type DiscordWebhookPayload,
  type DiscordWebhookSendResult
} from "./discord-notifications";
import type { NotificationSettings } from "./notification-settings";
import type { Reservation } from "./reservation-service";

export type ReservationCreatedNotificationSender = (
  payload: DiscordWebhookPayload
) => Promise<DiscordWebhookSendResult>;

export type ReservationCreatedNotificationResult =
  | {
      readonly kind: "failed";
      readonly message: string;
    }
  | {
      readonly kind: "sent";
      readonly messageIds: readonly string[];
    }
  | {
      readonly kind: "skipped";
      readonly reason: "disabled" | "webhook_missing";
    };

export async function sendReservationCreatedNotification(input: {
  readonly notificationSettings: NotificationSettings;
  readonly reservation: Reservation;
  readonly sender: ReservationCreatedNotificationSender;
  readonly webhookUrl: string | undefined;
}): Promise<ReservationCreatedNotificationResult> {
  if (!input.notificationSettings.reservationCreatedNotificationsEnabled) {
    return { kind: "skipped", reason: "disabled" };
  }
  if (!input.webhookUrl) {
    return { kind: "skipped", reason: "webhook_missing" };
  }

  try {
    const sendResult = await input.sender(
      buildReservationCreatedDiscordPayload({
        date: input.reservation.date,
        reservationId: input.reservation.id,
        studyPeriod: input.reservation.studyPeriod
      })
    );
    return { kind: "sent", messageIds: sendResult.messageIds };
  } catch (error) {
    return {
      kind: "failed",
      message: error instanceof Error
        ? redactDiscordWebhookTokens(error.message)
        : "Unknown Discord notification error"
    };
  }
}
