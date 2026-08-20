import { describe, expect, it } from "vitest";

import { buildDiscordAdminCommandClaimFilter } from "./prisma-discord-admin-command-runner-store";

const now = new Date("2026-08-20T05:00:00.000Z");
const leaseExpiredAt = new Date("2026-08-20T04:58:00.000Z");

describe("Discord administrator command claim filter", () => {
  it("limits immediate execution to the acknowledged interaction", () => {
    expect(buildDiscordAdminCommandClaimFilter({
      executionInteractionId: "interaction-1",
      leaseExpiredAt,
      now
    })).toMatchObject({
      executionInteractionId: "interaction-1",
      handshakeStatus: "ACKNOWLEDGED"
    });
  });

  it("claims all due acknowledged interactions from cron", () => {
    expect(buildDiscordAdminCommandClaimFilter({ leaseExpiredAt, now })).toMatchObject({
      executionInteractionId: { not: null },
      handshakeStatus: "ACKNOWLEDGED"
    });
  });
});
