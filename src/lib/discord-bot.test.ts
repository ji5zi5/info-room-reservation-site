import { TimeoutError } from "ky";
import { describe, expect, it } from "vitest";

import {
  canFallbackToDiscordWebhook,
  createDiscordBotClient,
  redactDiscordBotTokens,
  type DiscordBotMessagePayload
} from "./discord-bot";

const botToken = "super-secret-bot-token";
const payload = {
  allowed_mentions: { parse: [] },
  embeds: []
} satisfies DiscordBotMessagePayload;

describe("Discord bot REST transport", () => {
  it("creates, edits, and completes messages through the Discord REST endpoints", async () => {
    // Given: a bot client backed by a wire-level fetch fake.
    const requests: Request[] = [];
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(JSON.stringify({ id: "456" }), { status: 200 });
      }
    });

    // When: the three supported Discord message operations are performed.
    const created = await bot.createChannelMessage({ channelId: "321", payload, reservationId: "reservation-1" });
    const edited = await bot.editChannelMessage({ channelId: "321", messageId: "456", payload });
    const completed = await bot.editOriginalEphemeralResponse({ interactionToken: "interaction-token", payload });

    // Then: each endpoint and authentication mode match Discord's REST contract.
    expect(created).toEqual({ kind: "sent", messageId: "456" });
    expect(edited).toEqual({ kind: "sent", messageId: "456" });
    expect(completed).toEqual({ kind: "sent", messageId: "456" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://discord.com/api/v10/channels/321/messages",
      "https://discord.com/api/v10/channels/321/messages/456",
      "https://discord.com/api/v10/webhooks/123/interaction-token/messages/%40original"
    ]);
    expect(requests.slice(0, 2).map((request) => request.headers.get("authorization"))).toEqual([
      `Bot ${botToken}`,
      `Bot ${botToken}`
    ]);
    expect(requests[2]?.headers.get("authorization")).toBeNull();
    expect(await requests[0]?.json()).toMatchObject({ enforce_nonce: true, nonce: expect.any(String) });
  });

  it("waits for Discord retry_after before retrying a rate-limited message operation", async () => {
    // Given: Discord first responds with a 429 and a retry_after payload.
    const delays: number[] = [];
    let callCount = 0;
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(JSON.stringify({ retry_after: 1.25 }), {
            headers: { "content-type": "application/json" },
            status: 429
          });
        }
        return new Response(JSON.stringify({ id: "456" }), { status: 200 });
      },
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      }
    });

    // When: a channel message is edited.
    const result = await bot.editChannelMessage({ channelId: "321", messageId: "456", payload });

    // Then: the retry delay is exact and the request eventually succeeds.
    expect(result).toEqual({ kind: "sent", messageId: "456" });
    expect(delays).toEqual([1250]);
    expect(callCount).toBe(2);
  });

  it("does not retry an ambiguous create", async () => {
    // Given: the first create attempt loses its network response.
    const bodies: string[] = [];
    let callCount = 0;
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.text());
        callCount += 1;
        throw new TypeError("network response lost");
      }
    });

    // When: the bot creates a reservation message.
    const result = await bot.createChannelMessage({ channelId: "321", payload, reservationId: "reservation-1" });

    // Then: the durable outbox must reconcile the one ambiguous request.
    expect(result).toMatchObject({ kind: "unknown", outcome: "UNKNOWN" });
    expect(callCount).toBe(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"enforce_nonce":true');
    expect(bodies[0]).toContain('"nonce":"');
  });

  it("keeps a successful create response with a missing id ambiguous without retrying", async () => {
    // Given: Discord accepts the create but returns valid JSON without a message id.
    const bodies: string[] = [];
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.text());
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
    });

    // When: the bot creates a reservation message.
    const result = await bot.createChannelMessage({ channelId: "321", payload, reservationId: "reservation-1" });

    // Then: the outcome remains ambiguous, uses the same nonce, and cannot fall back to a webhook.
    expect(result).toMatchObject({ code: "discord_invalid_response", kind: "unknown", outcome: "UNKNOWN" });
    expect(canFallbackToDiscordWebhook(result)).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"nonce":"reservation-');
  });

  it("keeps a successful create response with malformed JSON ambiguous without retrying", async () => {
    // Given: Discord accepts the create but returns malformed JSON.
    const bodies: string[] = [];
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        bodies.push(await request.text());
        return new Response("{", {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
    });

    // When: the bot creates a reservation message.
    const result = await bot.createChannelMessage({ channelId: "321", payload, reservationId: "reservation-1" });

    // Then: the outcome remains ambiguous, uses the same nonce, and cannot fall back to a webhook.
    expect(result).toMatchObject({ code: "discord_invalid_response", kind: "unknown", outcome: "UNKNOWN" });
    expect(canFallbackToDiscordWebhook(result)).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('"enforce_nonce":true');
    expect(bodies[0]).toContain('"nonce":"reservation-');
  });

  it.each([204, 404])("treats Discord message deletion status %s as removed", async (status) => {
    // Given: Discord confirms deletion or reports that the message is already absent.
    const requests: Request[] = [];
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status });
      }
    });

    // When: a channel message is deleted.
    const result = await bot.deleteChannelMessage({ channelId: "321", messageId: "456" });

    // Then: the operation is safe to follow with conditional ledger cleanup.
    expect(result).toEqual({ kind: "removed" });
    expect(requests[0]?.method).toBe("DELETE");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bot ${botToken}`);
    expect(requests[0]?.url).toBe("https://discord.com/api/v10/channels/321/messages/456");
  });

  it("retains a failed deletion result without exposing the bot token", async () => {
    // Given: the transport fails with a diagnostic containing the bot token.
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => {
        throw new TypeError(`network failed for ${botToken}`);
      }
    });

    // When: a channel message deletion is attempted.
    const result = await bot.deleteChannelMessage({ channelId: "321", messageId: "456" });

    // Then: the retryable failure is typed and redacted.
    expect(result).toMatchObject({ code: "discord_network_error", kind: "failed" });
    if (result.kind === "failed") {
      expect(result.message).not.toContain(botToken);
    }
  });

  it.each([401, 403, 429, 500])("returns a redacted failed deletion for Discord HTTP %s", async (status) => {
    // Given: Discord refuses or cannot complete deletion and includes a secret response body.
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => new Response(`secret=${botToken}`, { status })
    });

    // When: a channel message deletion is attempted.
    const result = await bot.deleteChannelMessage({ channelId: "321", messageId: "456" });

    // Then: cleanup receives a retain-for-retry result without response content.
    expect(result).toMatchObject({ code: `discord_http_${status}`, kind: "failed" });
    if (result.kind === "failed") {
      expect(result.message).not.toContain(botToken);
    }
  });

  it("keeps timeout outcomes ambiguous and prevents a webhook fallback", async () => {
    // Given: Discord times out after accepting an unknown amount of request data.
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => {
        throw new TimeoutError(new Request("https://discord.com/api/v10/channels/321/messages"));
      }
    });

    // When: a channel-message edit has no confirmed response.
    const result = await bot.editChannelMessage({ channelId: "321", messageId: "456", payload });

    // Then: it is explicitly UNKNOWN and is ineligible for webhook fallback.
    expect(result).toMatchObject({ kind: "unknown", outcome: "UNKNOWN" });
    expect(canFallbackToDiscordWebhook(result)).toBe(false);
  });

  it("returns definite failures and redacts bot and interaction tokens from errors", async () => {
    // Given: an invalid request response that includes both secret forms in an error message.
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => new Response("invalid payload", { status: 400 })
    });

    // When: Discord rejects a message edit.
    const result = await bot.editOriginalEphemeralResponse({ interactionToken: "interaction-token", payload });

    // Then: the failure is definite and all secrets are removed from diagnostic text.
    expect(result).toMatchObject({ kind: "failed", code: "discord_http_400", outcome: "FAILED" });
    if (result.kind === "failed") {
      expect(result.message).not.toContain("interaction-token");
    }
    expect(redactDiscordBotTokens(`Bot ${botToken} /webhooks/123/interaction-token`, botToken)).toBe(
      "Bot [redacted] /webhooks/123/[redacted]"
    );
  });

  it.each([
    [200, { kind: "found", roleIds: ["33333333333333333"] }],
    [404, { kind: "missing" }],
    [429, { code: "discord_http_429", kind: "retryable_failure" }],
    [500, { code: "discord_http_500", kind: "retryable_failure" }],
    [401, { code: "discord_http_401", kind: "terminal_failure" }],
    [403, { code: "discord_http_403", kind: "terminal_failure" }]
  ] as const)("classifies current guild-member lookup status %s", async (status, expected) => {
    // Given
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => new Response(
        status === 200 ? JSON.stringify({ roles: ["33333333333333333"] }) : null,
        { headers: { "content-type": "application/json" }, status }
      )
    });

    // When
    const result = await bot.getGuildMember({ guildId: "555", userId: "444" });

    // Then
    expect(result).toEqual(expected);
  });

  it("classifies a current guild-member timeout as retryable", async () => {
    // Given
    const bot = createDiscordBotClient({
      applicationId: "123",
      botToken,
      fetch: async () => {
        throw new TimeoutError(new Request("https://discord.com/api/v10/guilds/555/members/444"));
      }
    });

    // When / Then
    await expect(bot.getGuildMember({ guildId: "555", userId: "444" })).resolves.toEqual({
      code: "discord_timeout",
      kind: "retryable_failure"
    });
  });
});
