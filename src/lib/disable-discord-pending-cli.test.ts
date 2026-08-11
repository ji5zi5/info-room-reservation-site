import { describe, expect, it, vi } from "vitest";

import {
  parseCommand,
  runDisableDiscordPendingCli,
  type DisableRuntime
} from "../../scripts/disable-discord-pending";

describe("disable Discord pending CLI", () => {
  it("rejects execution without the exact confirmation before creating a runtime", async () => {
    // Given: no destructive confirmation and a runtime factory that would expose mutation.
    const runtimeFactory = vi.fn<(config: DisableRuntime["config"], fixture: "active" | null) => DisableRuntime>();
    const stderr: string[] = [];

    // When: the CLI is invoked without confirmation.
    const exitCode = await runDisableDiscordPendingCli({ args: [], runtimeFactory, stderr: (line) => stderr.push(line) });

    // Then: it exits nonzero before any network or database runtime is created.
    expect(exitCode).toBe(1);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(stderr.join("\n")).toContain("DISABLE_DISCORD_INTERACTIONS");
  });

  it("rejects an incomplete application configuration after confirmation", async () => {
    // Given: explicit confirmation but no Discord app environment.
    const runtimeFactory = vi.fn<(config: DisableRuntime["config"], fixture: "active" | null) => DisableRuntime>();

    // When: the CLI validates configuration.
    const exitCode = await runDisableDiscordPendingCli({
      args: ["--confirm", "DISABLE_DISCORD_INTERACTIONS"],
      env: {},
      runtimeFactory,
      stderr: () => undefined
    });

    // Then: it exits nonzero without creating a writable runtime.
    expect(exitCode).toBe(1);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("accepts only the explicit confirmation and supported fixture", () => {
    // Given: the complete fixture-mode command.
    const args = ["--confirm", "DISABLE_DISCORD_INTERACTIONS", "--fixture", "active"];

    // When/Then: parsing produces the bounded fixture command.
    expect(parseCommand(args)).toEqual({ confirm: "DISABLE_DISCORD_INTERACTIONS", fixture: "active" });
  });
});
