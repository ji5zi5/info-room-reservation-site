import { createHash } from "node:crypto";

import ky, { HTTPError, isTimeoutError } from "ky";
import { z } from "zod";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_BOT_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_RETRIES = 1;
const INTERACTION_WEBHOOK_TOKEN_PATTERN =
  /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/v\d+\/webhooks\/\d+)\/[^/\s]+/gu;
const INTERACTION_WEBHOOK_PATH_TOKEN_PATTERN = /(\/webhooks\/\d+)\/[^/\s]+/gu;

const discordMessageResponseSchema = z.object({
  id: z.string().min(1)
});
const discordRateLimitResponseSchema = z.object({
  retry_after: z.number().finite().nonnegative()
});

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
      readonly code: "discord_network_error" | "discord_timeout";
      readonly message: string;
      readonly outcome: "UNKNOWN";
    };

export type DiscordBotClient = {
  readonly createChannelMessage: (input: {
    readonly channelId: string;
    readonly payload: DiscordBotMessagePayload;
    readonly reservationId: string;
  }) => Promise<DiscordBotDeliveryResult>;
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

type DiscordBotClientInput = {
  readonly applicationId: string;
  readonly botToken: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
};

type RequestOptions = {
  readonly authorization: "bot" | "none";
  readonly method: "PATCH" | "POST";
  readonly payload: DiscordBotMessagePayload;
  readonly url: string;
};

export function createDiscordBotClient(input: DiscordBotClientInput): DiscordBotClient {
  const sleep = input.sleep ?? sleepFor;
  const http = ky.create({
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    retry: { limit: 0 },
    timeout: DISCORD_BOT_TIMEOUT_MS
  });

  const send = async (request: RequestOptions): Promise<DiscordBotDeliveryResult> => {
    for (let retryCount = 0; retryCount <= MAX_RATE_LIMIT_RETRIES; retryCount += 1) {
      try {
        const body = await http(request.url, {
          headers: request.authorization === "bot" ? { authorization: `Bot ${input.botToken}` } : {},
          json: request.payload,
          method: request.method
        }).json<unknown>();
        return { kind: "sent", messageId: discordMessageResponseSchema.parse(body).id };
      } catch (error) {
        const rateLimitDelay = await getRateLimitDelay(error);
        if (rateLimitDelay !== null && retryCount < MAX_RATE_LIMIT_RETRIES) {
          await sleep(rateLimitDelay);
          continue;
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
        method: "POST",
        payload: {
          ...payload,
          enforce_nonce: true,
          nonce: buildReservationMessageNonce(reservationId)
        },
        url: `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages`
      };
      const firstResult = await send(request);
      return firstResult.kind === "unknown" ? send(request) : firstResult;
    },
    editChannelMessage: ({ channelId, messageId, payload }) =>
      send({
        authorization: "bot",
        method: "PATCH",
        payload,
        url: `${DISCORD_API_BASE_URL}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`
      }),
    editOriginalEphemeralResponse: ({ interactionToken, payload }) =>
      send({
        authorization: "none",
        method: "PATCH",
        payload,
        url: `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(input.applicationId)}/${encodeURIComponent(interactionToken)}/messages/%40original`
      })
  };
}

export function buildReservationMessageNonce(reservationId: string): string {
  return `reservation-${createHash("sha256").update(reservationId).digest("hex").slice(0, 12)}`;
}

export function canFallbackToDiscordWebhook(result: DiscordBotDeliveryResult): boolean {
  return result.kind === "failed";
}

export function redactDiscordBotTokens(message: string, botToken: string): string {
  return message
    .replaceAll(botToken, "[redacted]")
    .replace(INTERACTION_WEBHOOK_TOKEN_PATTERN, "$1/[redacted]")
    .replace(INTERACTION_WEBHOOK_PATH_TOKEN_PATTERN, "$1/[redacted]");
}

async function getRateLimitDelay(error: unknown): Promise<number | null> {
  if (!(error instanceof HTTPError) || error.response.status !== 429) {
    return null;
  }
  let response: unknown = null;
  try {
    response = await error.response.clone().json();
  } catch (parseError) {
    if (!(parseError instanceof SyntaxError)) {
      throw parseError;
    }
  }
  const parsed = discordRateLimitResponseSchema.safeParse(response);
  if (parsed.success) {
    return Math.ceil(parsed.data.retry_after * 1_000);
  }
  const retryAfter = Number(error.response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter * 1_000) : null;
}

function classifyDiscordBotError(error: unknown, botToken: string): DiscordBotDeliveryResult {
  if (isTimeoutError(error)) {
    return { code: "discord_timeout", kind: "unknown", message: redactErrorMessage(error, botToken), outcome: "UNKNOWN" };
  }
  if (error instanceof TypeError) {
    return {
      code: "discord_network_error",
      kind: "unknown",
      message: redactErrorMessage(error, botToken),
      outcome: "UNKNOWN"
    };
  }
  if (error instanceof HTTPError) {
    return {
      code: `discord_http_${error.response.status}`,
      kind: "failed",
      message: redactErrorMessage(error, botToken),
      outcome: "FAILED"
    };
  }
  return {
    code: "discord_send_failed",
    kind: "failed",
    message: redactErrorMessage(error, botToken),
    outcome: "FAILED"
  };
}

function redactErrorMessage(error: unknown, botToken: string): string {
  const message = error instanceof Error ? error.message : "Discord bot request failed";
  return redactDiscordBotTokens(message, botToken);
}

function sleepFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
