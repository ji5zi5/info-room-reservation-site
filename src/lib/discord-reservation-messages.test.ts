import { describe, expect, it } from "vitest";

import {
  buildDiscordReservationAcceptedMessage,
  buildDiscordReservationCancelledMessage,
  buildDiscordReservationInitialMessage,
  buildDiscordReservationStaleMessage,
  buildReservationMessageNonce
} from "./discord-reservation-messages";

const baseInput = {
  applicant: { name: "엄지오", studentNumber: "31001" },
  capacity: 10,
  closeTime: "16:20",
  confirmedCount: 9,
  date: "2026-06-17",
  reason: "과제",
  renderedEpoch: 7,
  reservationId: "reservation-1",
  customIdSecret: "discord-custom-id-test-secret",
  studyPeriod: "EIGHTH"
} as const;

describe("interactive Discord reservation messages", () => {
  it("renders a factual initial reservation message with conventional action buttons", () => {
    // Given: a reservation with one remaining seat and a known KST close time.
    const payload = buildDiscordReservationInitialMessage(baseInput);

    // When: the initial bot message is built.
    // Then: identity, reason, current capacity, deadline, mentions, and ordinary buttons are all present.
    expect(payload).toMatchObject({
      allowed_mentions: { parse: [] },
      components: [
        {
          components: [
            { custom_id: expect.stringMatching(/^dr2\.a\.7\./u), label: "수락", style: 3, type: 2 },
            { custom_id: expect.stringMatching(/^dr2\.r\.7\./u), label: "거절", style: 4, type: 2 }
          ],
          type: 1
        }
      ],
      embeds: [
        {
          fields: expect.arrayContaining([
            { inline: true, name: "신청자", value: "31001 엄지오" },
            { inline: false, name: "신청 사유", value: "과제" },
            { inline: true, name: "현재 신청", value: "9/10명" },
            { inline: true, name: "남은 자리", value: "1석" },
            { inline: false, name: "예약 마감", value: "2026-06-17 16:20 KST (<t:1781680800:R>)" }
          ]),
          title: "정보실 예약 신청"
        }
      ]
    });
  });

  it("clamps remaining seats at zero and preserves factual capacity boundaries", () => {
    // Given: full, one-seat-left, and empty reservation periods.
    const full = buildDiscordReservationInitialMessage({ ...baseInput, confirmedCount: 12 });
    const oneLeft = buildDiscordReservationInitialMessage(baseInput);
    const empty = buildDiscordReservationInitialMessage({ ...baseInput, confirmedCount: 0 });

    // When: each initial message is rendered.
    // Then: remaining seats never become negative and use the actual capacity.
    expect(full.embeds[0]?.fields.find((field) => field.name === "남은 자리")?.value).toBe("0석");
    expect(oneLeft.embeds[0]?.fields.find((field) => field.name === "남은 자리")?.value).toBe("1석");
    expect(empty.embeds[0]?.fields.find((field) => field.name === "남은 자리")?.value).toBe("10석");
  });

  it("renders accepted follow-up controls and removes controls from terminal outcomes", () => {
    // Given: accepted, cancelled, and stale reservation outcomes.
    const action = {
      actor: "Discord 관리자 223456789012345678",
      at: new Date("2026-08-11T01:03:00.000Z"),
      reason: "관리자 사유"
    } as const;
    const accepted = buildDiscordReservationAcceptedMessage({ ...baseInput, action });
    const cancelled = buildDiscordReservationCancelledMessage({ ...baseInput, action, cancellationReason: "관리자 사유" });
    const stale = buildDiscordReservationStaleMessage(baseInput);

    // When: their terminal Discord messages are rendered.
    // Then: accepted stays actionable while terminal payloads are mention-safe and inert.
    expect(accepted.components).toEqual([{ components: [
      expect.objectContaining({ custom_id: expect.stringMatching(/^dr2\.c\.7\./u), label: "관리자 취소" }),
      expect.objectContaining({ custom_id: expect.stringMatching(/^dr2\.n\.7\./u), label: "노쇼" })
    ], type: 1 }]);
    for (const payload of [cancelled, stale]) {
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(payload.components).toEqual([]);
    }
    expect(cancelled.embeds[0]?.fields).toContainEqual({ inline: false, name: "취소 사유", value: "관리자 사유" });
    expect(cancelled.embeds[0]?.fields).toContainEqual({ inline: false, name: "처리 관리자", value: action.actor });
    expect(cancelled.embeds[0]?.fields).toContainEqual({ inline: false, name: "처리 시각", value: action.at.toISOString() });
    expect(cancelled.embeds[0]?.fields).toContainEqual({ inline: false, name: "처리 사유", value: action.reason });
  });

  it("derives a stable Discord-safe nonce from a reservation identity", () => {
    // Given: two reservation identities.
    const first = buildReservationMessageNonce("reservation-1");
    const second = buildReservationMessageNonce("reservation-2");

    // When: each nonce is derived more than once.
    // Then: it is deterministic, unique to the identity, and within Discord's 25-character limit.
    expect(buildReservationMessageNonce("reservation-1")).toBe(first);
    expect(second).not.toBe(first);
    expect(first.length).toBeLessThanOrEqual(25);
  });
});
