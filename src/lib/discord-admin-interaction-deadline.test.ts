import { describe, expect, it, vi } from "vitest";

import { waitForDiscordAdminPreparation } from "./discord-admin-interaction-deadline";

describe("Discord administrator interaction deadline", () => {
  it("returns a completed preparation before the response deadline", async () => {
    // Given
    const prepared = { kind: "read" } as const;

    // When
    const result = await waitForDiscordAdminPreparation({
      prepare: async () => prepared,
      waitForDeadline: vi.fn().mockResolvedValue(false)
    });

    // Then
    expect(result).toEqual({ kind: "prepared", prepared });
  });

  it("returns the still-observable preparation when the response deadline wins", async () => {
    // Given
    let resolvePreparation: ((value: { readonly kind: "job" }) => void) | undefined;
    const preparation = new Promise<{ readonly kind: "job" }>((resolve) => {
      resolvePreparation = resolve;
    });

    // When
    const result = await waitForDiscordAdminPreparation({
      prepare: () => preparation,
      waitForDeadline: vi.fn().mockResolvedValue(true)
    });

    // Then
    expect(result.kind).toBe("timed_out");
    resolvePreparation?.({ kind: "job" });
    if (result.kind === "timed_out") {
      await expect(result.pending).resolves.toEqual({ kind: "prepared", prepared: { kind: "job" } });
    }
  });
});
