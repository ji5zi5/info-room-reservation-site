import { describe, expect, it } from "vitest";

import {
  buildDiscordOperationsBoardPayload,
  discordOperationsBoardStateDigest,
  type DiscordOperationsBoardSnapshot
} from "./discord-operations-board-contracts";

const snapshot: DiscordOperationsBoardSnapshot = {
  adminCommandBacklog: 0,
  closedNotificationsEnabled: true,
  date: "2026-08-20",
  interactionBacklog: 0,
  lastProcessedAt: "2026-08-20T04:59:00.000Z",
  operationalJobs: [],
  periods: [],
  reservationNotificationsEnabled: true,
  recentErrorCount: 0,
  unresolvedDeliveries: 0
};

describe("Discord operations board contracts", () => {
  it("keeps the state digest stable when only the observation time changes", () => {
    // Given: one board state observed at different times.
    const first = buildDiscordOperationsBoardPayload({ observedAt: new Date("2026-08-20T05:00:00Z"), revision: 1, secret: "secret", snapshot });
    const second = buildDiscordOperationsBoardPayload({ observedAt: new Date("2026-08-20T05:01:00Z"), revision: 1, secret: "secret", snapshot });

    // When: the state digest and rendered payloads are compared.
    const digest = discordOperationsBoardStateDigest(snapshot);

    // Then: time can change without forcing a board edit, while the rendered basis time remains available.
    expect(digest).toBe(discordOperationsBoardStateDigest({ ...snapshot }));
    expect(first).not.toEqual(second);
  });

  it("renders the last processing time and recent error count without exposing internal IDs", () => {
    const payload = buildDiscordOperationsBoardPayload({
      observedAt: new Date("2026-08-20T05:00:00Z"),
      revision: 1,
      secret: "secret",
      snapshot: { ...snapshot, recentErrorCount: 2 }
    });
    const rendered = JSON.stringify(payload);

    expect(rendered).toContain("최근 처리");
    expect(rendered).toContain("최근 오류 2건");
    expect(rendered).not.toContain("closed-period:");
  });
});
