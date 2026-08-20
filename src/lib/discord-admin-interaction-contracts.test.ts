import { describe, expect, it } from "vitest";

import {
  buildDiscordAdminReasonCustomId,
  buildDiscordAdminStudentSelectCustomId,
  buildDiscordOperationsBoardCustomId
} from "./discord-admin-custom-ids";
import { parseDiscordAdminInteraction } from "./discord-admin-interaction-contracts";

const secret = "discord-admin-test-secret";
const now = new Date("2026-08-20T05:00:00.000Z");

describe("Discord administrator interaction contracts", () => {
  it("parses the public status command with today's KST date", () => {
    // Given: a signed Discord application command from the configured operations channel.
    const payload = commandPayload({ name: "정보실", options: [{ name: "현황", type: 1 }] });

    // When: the interaction crosses the command boundary.
    const result = parseDiscordAdminInteraction(payload, secret, now);

    // Then: the command becomes a typed read intent.
    expect(result).toMatchObject({ intent: { date: "2026-08-20", kind: "status" }, kind: "command" });
  });

  it("parses a nested reservation cancellation as a reason draft", () => {
    // Given: a cancellation slash command with an explicit slot.
    const payload = commandPayload({
      name: "정보실",
      options: [{
        name: "예약",
        options: [{
          name: "취소",
          options: [
            { name: "학번", type: 3, value: "31001" },
            { name: "날짜", type: 3, value: "2026-08-21" },
            { name: "시간대", type: 3, value: "EIGHTH" }
          ],
          type: 1
        }],
        type: 2
      }]
    });

    // When: the interaction is parsed.
    const result = parseDiscordAdminInteraction(payload, secret, now);

    // Then: execution is held until a reason modal is submitted.
    expect(result).toMatchObject({
      intent: { date: "2026-08-21", kind: "reservation_cancel", studentNumber: "31001", studyPeriod: "EIGHTH" },
      kind: "command"
    });
  });

  it("accepts a signed reason modal and rejects a tampered source interaction", () => {
    // Given: a reason modal bound to the original slash command.
    const customId = buildDiscordAdminReasonCustomId({ secret, sourceInteractionId: "12345678901234575" });

    // When: the valid and tampered payloads are parsed.
    const valid = parseDiscordAdminInteraction(modalPayload(customId, "운영 사유"), secret, now);
    const tampered = parseDiscordAdminInteraction(modalPayload(`${customId}x`, "운영 사유"), secret, now);

    // Then: only the signed source is accepted.
    expect(valid).toMatchObject({ kind: "reason_submit", reason: "운영 사유", sourceInteractionId: "12345678901234575" });
    expect(tampered).toEqual({ kind: "invalid" });
  });

  it("parses a signed operations-board control and rejects a stale signature", () => {
    // Given: a board refresh control at revision 4.
    const customId = buildDiscordOperationsBoardCustomId({ action: "refresh", revision: 4, secret });

    // When: the button payload is parsed with the right and wrong secrets.
    const valid = parseDiscordAdminInteraction(boardPayload(customId), secret, now);
    const invalid = parseDiscordAdminInteraction(boardPayload(customId), "wrong-secret", now);

    // Then: only the authenticated board action is exposed.
    expect(valid).toMatchObject({ action: "refresh", kind: "board_component", revision: 4 });
    expect(invalid).toEqual({ kind: "invalid" });
  });

  it("parses a signed student selection into an exact student lookup", () => {
    const customId = buildDiscordAdminStudentSelectCustomId({ secret });

    const result = parseDiscordAdminInteraction(studentSelectPayload(customId, "31001"), secret, now);

    expect(result).toMatchObject({
      intent: { kind: "student_lookup", query: "31001" },
      kind: "command"
    });
  });
});

function commandPayload(data: unknown): unknown {
  return { ...sourcePayload(), data, type: 2 };
}

function modalPayload(customId: string, reason: string): unknown {
  return {
    ...sourcePayload(),
    data: { components: [{ components: [{ custom_id: "reason", type: 4, value: reason }], type: 1 }], custom_id: customId },
    type: 5
  };
}

function boardPayload(customId: string): unknown {
  return { ...sourcePayload(), data: { component_type: 2, custom_id: customId }, message: { id: "12345678901234576" }, type: 3 };
}

function studentSelectPayload(customId: string, studentNumber: string): unknown {
  return {
    ...sourcePayload(),
    data: { component_type: 3, custom_id: customId, values: [studentNumber] },
    message: { id: "12345678901234576" },
    type: 3
  };
}

function sourcePayload() {
  return {
    application_id: "12345678901234567",
    channel_id: "12345678901234568",
    guild_id: "12345678901234569",
    id: "12345678901234570",
    member: { roles: ["12345678901234571"], user: { id: "12345678901234572" } },
    token: "interaction-token"
  };
}
