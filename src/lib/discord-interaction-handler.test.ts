import { describe, expect, it, vi } from "vitest";

import type { DiscordApplicationConfig } from "./discord-app-config";
import type { DiscordInteractionDispatchResult, DiscordInteractionJobClaim } from "./discord-interaction-job-runner";
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
const ipHash = "b".repeat(64);

describe("Discord interaction durable handler", () => {
  it.each(["reject", "admin_cancel", "no_show"] as const)(
    "authorizes a %s modal against the signed source identity and durable ledger",
    async (kind) => {
      // Given
      const dependencies = dependenciesFor();
      const handler = createDiscordInteractionHandler(dependencies);

      // When
      const result = await handler.authorizeModal({ config, interaction: componentInteraction(kind) });

      // Then
      expect(result).toEqual({ kind: "authorized" });
      expect(dependencies.loadContext).toHaveBeenCalledWith({ messageId: "523456789012345678", studentNumber: "31001" });
      expect(dependencies.stage).not.toHaveBeenCalled();
    }
  );

  it("stages immutable token-free facts and activates PENDING before acknowledging", async () => {
    // Given
    const events: string[] = [];
    const dependencies = dependenciesFor();
    dependencies.stage.mockImplementation(async () => { events.push("stage"); return { kind: "enqueued" }; });
    dependencies.activate.mockImplementation(async () => { events.push("activate"); return { kind: "pending" }; });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const result = await handler.acknowledge({ config, interaction: componentInteraction("accept"), ipHash });

    // Then
    expect(result).toEqual({ kind: "acknowledged" });
    expect(events).toEqual(["stage", "activate"]);
    const staged = dependencies.stage.mock.calls[0]?.[0];
    expect(staged).toMatchObject({
      activationDeadline: new Date("2026-08-13T00:00:01.500Z"),
      discordActorId: "723456789012345678",
      interactionId: "423456789012345678",
      intent: "{\"kind\":\"accept\",\"studentNumber\":\"31001\"}",
      localActorId: "admin-1",
      renderedEpoch: 7,
      reservationId: "reservation-1",
      sourceApplicationId: config.applicationId
    });
    expect(Object.keys(staged ?? {})).not.toEqual(expect.arrayContaining(["interactionToken", "rawBody", "requestRoleIds"]));
  });

  it("abandons at the route deadline and cannot schedule work when a late insert completes", async () => {
    // Given
    let finishInsert: ((value: { readonly kind: "enqueued" }) => void) | undefined;
    let reachDeadline: (() => void) | undefined;
    const dependencies = dependenciesFor();
    dependencies.stage.mockImplementation(() => {
      reachDeadline?.();
      return new Promise((resolve) => { finishInsert = resolve; });
    });
    dependencies.waitForDeadline.mockImplementation(() => new Promise((resolve) => {
      reachDeadline = () => resolve(true);
    }));
    dependencies.settle.mockResolvedValue({ kind: "abandoned" });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const result = await handler.acknowledge({ config, interaction: componentInteraction("accept"), ipHash });
    finishInsert?.({ kind: "enqueued" });
    await Promise.resolve();

    // Then
    expect(result).toEqual({ kind: "rejected" });
    expect(dependencies.settle).toHaveBeenCalledOnce();
    expect(dependencies.activate).not.toHaveBeenCalled();
    expect(dependencies.runJobs).not.toHaveBeenCalled();
  });

  it("returns one deferred acknowledgement when activation wins the timeout race", async () => {
    // Given
    let reachDeadline: (() => void) | undefined;
    const dependencies = dependenciesFor();
    dependencies.stage.mockImplementation(() => {
      reachDeadline?.();
      return new Promise(() => undefined);
    });
    dependencies.waitForDeadline.mockImplementation(() => new Promise((resolve) => {
      reachDeadline = () => resolve(true);
    }));
    dependencies.settle.mockResolvedValue({ kind: "pending" });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const result = await handler.acknowledge({ config, interaction: componentInteraction("accept"), ipHash });

    // Then
    expect(result).toEqual({ kind: "acknowledged" });
    expect(dependencies.settle).toHaveBeenCalledOnce();
    expect(dependencies.runJobs).not.toHaveBeenCalled();
  });

  it("does not return while deadline settlement is unresolved", async () => {
    // Given
    let reachRouteDeadline: (() => void) | undefined;
    let finishSettlement: ((value: { readonly kind: "abandoned" }) => void) | undefined;
    let completed = false;
    let waits = 0;
    const dependencies = dependenciesFor();
    dependencies.stage.mockImplementation(() => {
      reachRouteDeadline?.();
      return new Promise(() => undefined);
    });
    dependencies.settle.mockImplementation(() => new Promise((resolve) => { finishSettlement = resolve; }));
    dependencies.waitForDeadline.mockImplementation(() => {
      waits += 1;
      return waits === 1
        ? new Promise((resolve) => { reachRouteDeadline = () => resolve(true); })
        : Promise.resolve(true);
    });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const acknowledgement = handler.acknowledge({ config, interaction: componentInteraction("accept"), ipHash })
      .then((result) => { completed = true; return result; });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Then: no application timer may outrun the durable settlement call.
    expect(completed).toBe(false);
    finishSettlement?.({ kind: "abandoned" });
    const result = await acknowledgement;
    expect(result).toEqual({ kind: "rejected" });
    expect(dependencies.activate).not.toHaveBeenCalled();
  });

  it("settles a failed stage durably before returning the generic outcome", async () => {
    // Given: the bounded stage call fails after its identity may have reached PostgreSQL.
    const events: string[] = [];
    const dependencies = dependenciesFor();
    dependencies.stage.mockImplementation(async () => {
      events.push("stage_failed");
      throw new TypeError("bounded stage failure");
    });
    dependencies.settle.mockImplementation(async () => {
      events.push("settled");
      return { kind: "abandoned" };
    });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const result = await handler.acknowledge({ config, interaction: componentInteraction("accept"), ipHash });

    // Then
    expect(result).toEqual({ kind: "rejected" });
    expect(events).toEqual(["stage_failed", "settled"]);
  });

  it("propagates bounded settlement failure instead of returning an unresolved generic outcome", async () => {
    // Given: both the stage and the repository settlement contract report failure.
    const dependencies = dependenciesFor();
    dependencies.stage.mockRejectedValue(new TypeError("bounded stage failure"));
    dependencies.settle.mockRejectedValue(new TypeError("bounded settlement failure"));
    const handler = createDiscordInteractionHandler(dependencies);

    // When / Then
    await expect(handler.acknowledge({
      config, interaction: componentInteraction("accept"), ipHash
    })).rejects.toThrow("bounded settlement failure");
  });

  it("fails closed for a digest collision and never activates", async () => {
    // Given
    const dependencies = dependenciesFor();
    dependencies.stage.mockResolvedValue({ kind: "security_conflict" });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    const result = await handler.acknowledge({ config, interaction: componentInteraction("accept"), ipHash });

    // Then
    expect(result).toEqual({ kind: "rejected" });
    expect(dependencies.activate).not.toHaveBeenCalled();
  });

  it("runs only the exact PENDING job and uses the token only for its ephemeral completion", async () => {
    // Given
    const dependencies = dependenciesFor();
    dependencies.runJobs.mockResolvedValue({ abandoned: 0, claimed: 1, retried: 0, stale: 0, succeeded: 1 });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    await handler.runExact({
      applicationId: config.applicationId,
      botToken: config.botToken,
      interactionId: "423456789012345678",
      interactionToken: "ephemeral-token"
    });

    // Then
    expect(dependencies.runJobs).toHaveBeenCalledWith(expect.objectContaining({ interactionId: "423456789012345678" }));
    expect(dependencies.editCompletion).toHaveBeenCalledWith(expect.objectContaining({ interactionToken: "ephemeral-token" }));
    expect(JSON.stringify(dependencies.runJobs.mock.calls)).not.toContain("ephemeral-token");
  });

  it("fails a persisted digest collision closed before reservation dispatch", async () => {
    // Given
    const dependencies = dependenciesFor();
    dependencies.runJobs.mockImplementation(async (input: {
      readonly dispatch: (claim: DiscordInteractionJobClaim) => Promise<DiscordInteractionDispatchResult>;
    }) => {
      const outcome = await input.dispatch({
        attempts: 1,
        claimId: "claim-1",
        commandDigest: "sha256:attacker-controlled-collision",
        discordActorId: "723456789012345678",
        interactionId: "423456789012345678",
        intent: JSON.stringify({ kind: "accept", studentNumber: "31001" }),
        ipHash,
        localActorId: "admin-1",
        renderedEpoch: 7,
        reservationId: "reservation-1",
        sourceApplicationId: config.applicationId,
        sourceChannelId: config.channelId,
        sourceGuildId: config.guildId,
        sourceMessageId: "523456789012345678"
      });
      expect(outcome).toMatchObject({ errorCode: "persisted_command_invalid", kind: "terminal_failure" });
      return { abandoned: 1, claimed: 1, retried: 0, stale: 0, succeeded: 0 };
    });
    const handler = createDiscordInteractionHandler(dependencies);

    // When
    await handler.runExact({
      applicationId: config.applicationId,
      botToken: config.botToken,
      interactionId: "423456789012345678",
      interactionToken: "ephemeral-token"
    });

    // Then
    expect(dependencies.dispatch).not.toHaveBeenCalled();
  });
});

function dependenciesFor() {
  return {
    activate: vi.fn().mockResolvedValue({ kind: "pending" }),
    clockMs: vi.fn().mockReturnValue(10_000),
    dispatch: vi.fn().mockResolvedValue({ kind: "succeeded", terminalResult: { kind: "accepted" } }),
    editCompletion: vi.fn().mockResolvedValue({ kind: "sent", messageId: "ephemeral" }),
    loadContext: vi.fn().mockResolvedValue({
      channelId: config.channelId,
      databaseNow: new Date("2026-08-13T00:00:00.000Z"),
      guildId: config.guildId,
      localActorId: "admin-1",
      messageId: "523456789012345678",
      nonce: "source-message-1",
      renderedEpoch: 7,
      reservationId: "reservation-1",
      studentNumber: "31001"
    }),
    runJobs: vi.fn().mockResolvedValue({ abandoned: 0, claimed: 0, retried: 0, stale: 0, succeeded: 0 }),
    stage: vi.fn().mockResolvedValue({ kind: "enqueued" }),
    settle: vi.fn().mockResolvedValue({ kind: "abandoned" }),
    waitForDeadline: vi.fn().mockImplementation(() => new Promise(() => undefined))
  };
}

function componentInteraction(kind: "accept" | "admin_cancel" | "no_show" | "reject"): Extract<
  DiscordReservationInteraction,
  { readonly kind: "component" }
> {
  return {
    applicationId: config.applicationId,
    channelId: config.channelId,
    command: { kind, renderedEpoch: 7, reservationId: "reservation-1", sourceIdentity: "source-message-1" },
    discordUserId: "723456789012345678",
    guildId: config.guildId,
    interactionId: "423456789012345678",
    interactionToken: "interaction-token",
    kind: "component",
    messageId: "523456789012345678",
    roleIds: [config.adminRoleId]
  };
}
