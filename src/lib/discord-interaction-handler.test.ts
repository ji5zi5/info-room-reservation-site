import { describe, expect, it, vi } from "vitest";

import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordReservationDecisionResult } from "./discord-reservation-operations";
import type { DiscordReservationInteraction } from "./discord-interactions";
import { createDiscordInteractionHandler } from "./discord-interaction-handler";

const config: DiscordApplicationConfig = {
  adminRoleId: "623456789012345678",
  adminUserBindings: [{ discordUserId: "723456789012345678", studentNumber: "31001" }],
  applicationId: "123456789012345678",
  botToken: "bot-token",
  channelId: "223456789012345678",
  guildId: "323456789012345678",
  publicKey: "a".repeat(64)
};
const ledger = { messageId: "523456789012345678", reservationId: "reservation-1" } as const;
const ipHash = "b".repeat(64);

describe("Discord interaction deferred handler", () => {
  it("authorizes a reject component against its durable source ledger", async () => {
    // Given
    const dependencies = dependenciesFor({ kind: "accepted", reservationId: ledger.reservationId });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const result = await handler.authorizeRejectComponent({ config, interaction: componentInteraction("reject") });

    // Then
    expect(result).toEqual({ kind: "authorized", reservationId: ledger.reservationId });
    expect(dependencies.loadLedger).toHaveBeenCalledWith(ledger.messageId);
    expect(dependencies.processDecision).not.toHaveBeenCalled();
  });

  it("processes an authorized accept, triggers source sync, and completes the ephemeral response", async () => {
    // Given
    const events: string[] = [];
    const dependencies = dependenciesFor({ kind: "accepted", reservationId: ledger.reservationId });
    dependencies.processDecision.mockImplementation(async () => { events.push("decision"); return { kind: "accepted", reservationId: ledger.reservationId }; });
    dependencies.runOutbox.mockImplementation(async () => { events.push("outbox"); return undefined; });
    dependencies.editCompletion.mockImplementation(async () => { events.push("completion"); return { kind: "sent", messageId: "@original" }; });

    // When
    await createDiscordInteractionHandler(dependencies).runDeferred({ config, interaction: componentInteraction("accept"), ipHash });

    // Then
    expect(events).toEqual(["decision", "outbox", "completion"]);
    expect(dependencies.processDecision).toHaveBeenCalledWith(expect.objectContaining({ ipHash }));
    expect(dependencies.runOutbox).toHaveBeenCalledWith(expect.objectContaining({ reservationId: ledger.reservationId }));
    expect(dependencies.editCompletion).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: config.applicationId,
      botToken: config.botToken,
      interactionToken: "interaction-token",
      payload: expect.objectContaining({ allowed_mentions: { parse: [] }, embeds: expect.any(Array) })
    }));
  });

  it("processes an authorized reject modal with its exact reason", async () => {
    // Given
    const dependencies = dependenciesFor({ kind: "cancelled", reservationId: ledger.reservationId });

    // When
    await createDiscordInteractionHandler(dependencies).runDeferred({ config, interaction: modalInteraction(), ipHash });

    // Then
    expect(dependencies.processDecision).toHaveBeenCalledWith({
      command: expect.objectContaining({ kind: "reject", reason: "행사 준비", reservationId: ledger.reservationId }),
      ipHash,
      now: expect.any(Date)
    });
    expect(dependencies.runOutbox).toHaveBeenCalledOnce();
    expect(dependencies.editCompletion).toHaveBeenCalledOnce();
  });

  it.each([
    ["application", { applicationId: "999999999999999999" }],
    ["guild", { guildId: "999999999999999999" }],
    ["channel", { channelId: "999999999999999999" }],
    ["message", { messageId: "999999999999999999" }],
    ["role", { roleIds: [] }],
    ["map", { discordUserId: "999999999999999999" }]
  ] as const)("does not mutate when the %s authorization guard fails", async (_scenario, changes) => {
    // Given
    const dependencies = dependenciesFor({ kind: "accepted", reservationId: ledger.reservationId });
    const interaction = { ...componentInteraction("accept"), ...changes };

    // When
    await createDiscordInteractionHandler(dependencies).runDeferred({ config, interaction, ipHash });

    // Then
    expect(dependencies.processDecision).not.toHaveBeenCalled();
    expect(dependencies.runOutbox).not.toHaveBeenCalled();
    expect(dependencies.editCompletion).toHaveBeenCalledOnce();
  });

  it("treats ephemeral completion failure as best-effort without exposing tokens", async () => {
    // Given
    const dependencies = dependenciesFor({ code: "reservation_not_found", kind: "noop" });
    dependencies.editCompletion.mockResolvedValue({ code: "discord_http_404", kind: "failed", message: "redacted", outcome: "FAILED" });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // When
    await createDiscordInteractionHandler(dependencies).runDeferred({ config, interaction: componentInteraction("accept"), ipHash });

    // Then
    expect(dependencies.runOutbox).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain("interaction-token");
    expect(JSON.stringify(log.mock.calls)).not.toContain("bot-token");
  });
});

function dependenciesFor(result: DiscordReservationDecisionResult) {
  return {
    editCompletion: vi.fn().mockResolvedValue({ kind: "sent", messageId: "@original" }),
    loadLedger: vi.fn().mockResolvedValue(ledger),
    processDecision: vi.fn().mockResolvedValue(result),
    runOutbox: vi.fn().mockResolvedValue(undefined)
  };
}

function componentInteraction(kind: "accept" | "reject"): Extract<DiscordReservationInteraction, { readonly kind: "component" }> {
  return {
    applicationId: config.applicationId, channelId: config.channelId,
    command: { kind, reservationId: ledger.reservationId }, discordUserId: config.adminUserBindings[0]?.discordUserId ?? "",
    guildId: config.guildId, interactionId: "423456789012345678", interactionToken: "interaction-token",
    kind: "component", messageId: ledger.messageId, roleIds: [config.adminRoleId]
  };
}

function modalInteraction(): Extract<DiscordReservationInteraction, { readonly kind: "modal_submit" }> {
  return {
    ...componentInteraction("reject"),
    command: { kind: "reject", reason: "행사 준비", reservationId: ledger.reservationId },
    kind: "modal_submit"
  };
}
