import { describe, expect, it, vi } from "vitest";

import { emitStructuredOperationalEvent, serializeStructuredOperationalEvent } from "./structured-operational-log";

describe("structured operational log", () => {
  it("serializes only the redacted operational allowlist", () => {
    const input = {
      durationMs: 17,
      errorCode: "discord_http_500",
      event: "maintenance.stage",
      jobId: "MAINTENANCE",
      reservationId: "reservation-1",
      result: "blocked",
      runId: "run-1",
      stage: "discord_messages"
    } as const;
    const unsafeInput = Object.assign(input, {
      applicant: "student-name",
      reason: "private reason",
      token: "secret-token",
      webhookUrl: "https://discord.test/secret"
    });

    expect(serializeStructuredOperationalEvent(unsafeInput)).toMatchInlineSnapshot(
      `"{\"durationMs\":17,\"errorCode\":\"discord_http_500\",\"event\":\"maintenance.stage\",\"jobId\":\"MAINTENANCE\",\"reservationId\":\"reservation-1\",\"result\":\"blocked\",\"runId\":\"run-1\",\"stage\":\"discord_messages\"}"`
    );
  });

  it("redacts malformed identifiers and error text before emission", () => {
    const sink = vi.fn();

    emitStructuredOperationalEvent({
      durationMs: 1,
      errorCode: "Bearer secret credential",
      event: "maintenance.stage",
      jobId: "MAINTENANCE",
      reservationId: "student@example.test",
      result: "failed",
      runId: "run with token",
      stage: "discord_messages"
    }, sink);

    expect(sink).toHaveBeenCalledWith(
      "{\"durationMs\":1,\"errorCode\":\"redacted_error\",\"event\":\"maintenance.stage\",\"jobId\":\"MAINTENANCE\",\"reservationId\":\"redacted\",\"result\":\"failed\",\"runId\":\"redacted\",\"stage\":\"discord_messages\"}"
    );
  });
});
