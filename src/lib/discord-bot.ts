import { createHash } from "node:crypto";

import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";

import { classifyDiscordBotError, getDiscordRateLimitDelay } from "./discord-bot-errors";

export { redactDiscordBotTokens } from "./discord-bot-errors";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_BOT_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 1;
export const DISCORD_CHANNEL_HISTORY_MAX_PAGE_SIZE = 100;

const discordMessageResponseSchema = z.object({
  id: z.string().min(1)
});
const discordGuildMemberSchema = z.object({
  roles: z.array(z.string())
});
const discordChannelHistorySchema = z.array(z.object({
  id: z.string().min(1),
  nonce: z.union([z.string(), z.null()]).optional()
}));

export type DiscordEmbedField = {
  readonly inline: boolean;
  readonly name: string;
  readonly value: string;
};

export type DiscordEmbed = {
  readonly color: number;
  readonly description: string;
  readonly fields: readonly DiscordEmbedField[];
  readonly title: string;
};

export type DiscordButtonComponent = {
  readonly custom_id: string;
  readonly label: string;
  readonly style: 1 | 2 | 3 | 4 | 5;
  readonly type: 2;
};

export type DiscordActionRowComponent = {
  readonly components: readonly DiscordButtonComponent[];
  readonly type: 1;
};

export type DiscordBotMessagePayload = {
  readonly allowed_mentions: {
    readonly parse: readonly string[];
  };
  readonly components?: readonly DiscordActionRowComponent[];
  readonly enforce_nonce?: boolean;
  readonly embeds: readonly DiscordEmbed[];
  readonly nonce?: string;
};

export type DiscordBotDeliveryResult =
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
      readonly outcome: "FAILED";
    }
  | {
      readonly kind: "sent";
      readonly messageId: string;
    }
  | {
      readonly kind: "unknown";
      readonly code: "discord_invalid_response" | "discord_network_error" | "discord_timeout";
      readonly message: string;
      readonly outcome: "UNKNOWN";
    };

export type DiscordBotDeleteResult =
  | { readonly kind: "removed" }
  | { readonly code: string; readonly kind: "failed"; readonly message: string };

export type DiscordGuildMemberLookupResult =
  | { readonly kind: "found"; readonly roleIds: readonly string[] }
  | { readonly kind: "missing" }
  | { readonly code: string; readonly kind: "retryable_failure" }
  | { readonly code: string; readonly kind: "terminal_failure" };

export type DiscordChannelHistoryPageResult =
  | {
      readonly kind: "found";
      readonly messages: readonly {
        readonly id: string;
        readonly nonce: string | null;
      }[];
    }
  | { readonly code: string; readonly kind: "retryable_failure" }
  | { readonly code: string; readonly kind: "terminal_failure" };

export type DiscordChannelHistoryClient = {
  readonly listChannelMessagesPage: (input: {
    readonly before?: string;
    readonly channelId: string;
    readonly limit: number;
  }) => Promise<DiscordChannelHistoryPageResult>;
};

export type DiscordBotClient = {
  readonly createChannelMessage: (input: {
    readonly channelId: string;
    readonly payload: DiscordBotMessagePayload;
    readonly reservationId: string;
  }) => Promise<DiscordBotDeliveryResult>;
  readonly deleteChannelMessage: (input: {
    readonly channelId: string;
    readonly messageId: string;
  }) => Promise<DiscordBotDeleteResult>;
  readonly editChannelMessage: (input: {
    readonly channelId: string;
    readonly messageId: string;
    readonly payload: DiscordBotMessagePayload;
  }) => Promise<DiscordBotDeliveryResult>;
  readonly editOriginalEphemeralResponse: (input: {
    readonly interactionToken: string;
    readonly payload: DiscordBotMessagePayload;
  }) => Promise<DiscordBotDeliveryResult>;
};

export type DiscordGuildMemberClient = {
  readonly getGuildMember: (input: {
    readonly guildId: string;
    readonly userId: string;
  }) => Promise<DiscordGuildMemberLookupResult>;
};

type DiscordBotClientInput = {
  readonly applicationId: string;
  readonly botToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type RequestOptions = {
  readonly authorization: "bot" | "none";
  readonly invalidResponseOutcome: "failed" | "unknown";
  readonly method: "PATCH" | "POST";
  readonly payload: DiscordBotMessagePayload;
  readonly url: string;
};

export function createDiscordBotClient(
  input: DiscordBotClientInput
): DiscordBotClient & DiscordGuildMemberClient & DiscordChannelHistoryClient {
  const sleep = input.sleep ?? sleepFor;
  const http = ky.create({
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    retry: { limit: 0 },
    timeout: DISCORD_BOT_TIMEOUT_MS
  });

  const send = async (
    request: RequestOptions,
    maxRateLimitRetries: number = MAX_RATE_LIMIT_RETRIES
  ): Promise<DiscordBotDeliveryResult> => {
    for (let retryCount = 0; retryCount <= maxRateLimitRetries; retryCount += 1) {
      try {
        const body = await http(request.url, {
          headers: request.authorization === "bot" ? { authorization: `Bot ${input.botToken}` } : {},
          json: { ...request.payload, allowed_mentions: { parse: [] } },
          method: request.method
        }).json<unknown>();
        return { kind: "sent", messageId: discordMessageResponseSchema.parse(body).id };
      } catch (error) {
        const rateLimitDelay = await getDiscordRateLimitDelay(error);
        if (rateLimitDelay !== null && retryCount < maxRateLimitRetries) {
          await sleep(rateLimitDelay);
          continue;
        }
        if (error instanceof SyntaxError || error instanceof z.ZodError) {
          return request.invalidResponseOutcome === "unknown"
            ? {
                code: "discord_invalid_response",
                kind: "unknown",
                message: "Discord response did not include a valid message id",
                outcome: "UNKNOWN"
              }
            : {
                code: "discord_invalid_response",
                kind: "failed",
                message: "Discord response did not include a valid message id",
                outcome: "FAILED"
              };
        }
        return classifyDiscordBotError(error, input.botToken);
      }
    }
    return { code: "discord_send_failed", kind: "failed", message: "Discord bot request failed", outcome: "FAILED" };
  };

  return {
    createChannelMessage: async ({ channelId, payload, reservationId }) => {
      const request: RequestOptions = {
        authorization: "bot",
        invalidResponseOutcome: "unknown",
        method: "POST",
        payload: {
          ...payload,
          enforce_nonce: true,
          nonce: buildReservationMessageNonce(reservationId)
        },
        url: `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages`
      };
      return send(request, 0);
    },
    deleteChannelMessage: async ({ channelId, messageId }) => {
      try {
        await http.delete(
          `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
          { headers: { authorization: `Bot ${input.botToken}` } }
        );
        return { kind: "removed" };
      } catch (error) {
        if (error instanceof HTTPError && error.response.status === 404) {
          return { kind: "removed" };
        }
        const classified = classifyDiscordBotError(error, input.botToken);
        return { code: classified.code, kind: "failed", message: classified.message };
      }
    },
    editChannelMessage: ({ channelId, messageId, payload }) =>
      send({
        authorization: "bot",
        invalidResponseOutcome: "unknown",
        method: "PATCH",
        payload,
        url: `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`
      }),
    editOriginalEphemeralResponse: ({ interactionToken, payload }) =>
      send({
        authorization: "none",
        invalidResponseOutcome: "failed",
        method: "PATCH",
        payload,
        url: `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(input.applicationId)}/${encodeURIComponent(interactionToken)}/messages/%40original`
      }),
    getGuildMember: async ({ guildId, userId }) => {
      try {
        const body = await http.get(
          `${DISCORD_API_BASE_URL}/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(userId)}`,
          { headers: { authorization: `Bot ${input.botToken}` } }
        ).json<unknown>();
        const parsed = discordGuildMemberSchema.safeParse(body);
        return parsed.success
          ? { kind: "found", roleIds: parsed.data.roles }
          : { code: "discord_invalid_member_response", kind: "retryable_failure" };
      } catch (error) {
        if (error instanceof HTTPError) {
          const status = error.response.status;
          if (status === 404) return { kind: "missing" };
          if (status === 401 || status === 403) {
            return { code: `discord_http_${status}`, kind: "terminal_failure" };
          }
          return { code: `discord_http_${status}`, kind: "retryable_failure" };
        }
        if (error instanceof TimeoutError || error instanceof TypeError) {
          return {
            code: error instanceof TimeoutError ? "discord_timeout" : "discord_network_error",
            kind: "retryable_failure"
          };
        }
        throw error;
      }
    },
    listChannelMessagesPage: async ({ before, channelId, limit }) => {
      const boundedLimit = Math.max(1, Math.min(DISCORD_CHANNEL_HISTORY_MAX_PAGE_SIZE, Math.trunc(limit)));
      const searchParams = new URLSearchParams({ limit: String(boundedLimit) });
      if (before !== undefined) searchParams.set("before", before);
      try {
        const body = await http.get(
          `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages?${searchParams.toString()}`,
          { headers: { authorization: `Bot ${input.botToken}` } }
        ).json<unknown>();
        const parsed = discordChannelHistorySchema.safeParse(body);
        return parsed.success
          ? {
              kind: "found",
              messages: parsed.data.map((message) => ({ id: message.id, nonce: message.nonce ?? null }))
            }
          : { code: "discord_invalid_history_response", kind: "retryable_failure" };
      } catch (error) {
        if (error instanceof HTTPError) {
          const status = error.response.status;
          return status === 401 || status === 403
            ? { code: `discord_http_${status}`, kind: "terminal_failure" }
            : { code: `discord_http_${status}`, kind: "retryable_failure" };
        }
        if (error instanceof TimeoutError || error instanceof TypeError || error instanceof SyntaxError) {
          return {
            code: error instanceof TimeoutError
              ? "discord_timeout"
              : error instanceof SyntaxError
                ? "discord_invalid_history_response"
                : "discord_network_error",
            kind: "retryable_failure"
          };
        }
        throw error;
      }
    }
  };
}

export function buildReservationMessageNonce(reservationId: string): string {
  return `reservation-${createHash("sha256").update(reservationId).digest("hex").slice(0, 12)}`;
}

export function canFallbackToDiscordWebhook(result: DiscordBotDeliveryResult): boolean {
  return result.kind === "failed";
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
