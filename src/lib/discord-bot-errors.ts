import { HTTPError, isTimeoutError } from "ky";
import { z } from "zod";

import type { DiscordBotDeliveryResult } from "./discord-bot";

const INTERACTION_WEBHOOK_TOKEN_PATTERN =
  /(https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/v\d+\/webhooks\/\d+)\/[^/\s]+/gu;
const INTERACTION_WEBHOOK_PATH_TOKEN_PATTERN = /(\/webhooks\/\d+)\/[^/\s]+/gu;
const discordRateLimitResponseSchema = z.object({
  retry_after: z.number().finite().nonnegative()
});

type DiscordBotErrorResult = Exclude<DiscordBotDeliveryResult, { readonly kind: "sent" }>;

export async function getDiscordRateLimitDelay(error: unknown): Promise<number | null> {
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

export function classifyDiscordBotError(error: unknown, botToken: string): DiscordBotErrorResult {
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

export function redactDiscordBotTokens(message: string, botToken: string): string {
  return message
    .replaceAll(botToken, "[redacted]")
    .replace(INTERACTION_WEBHOOK_TOKEN_PATTERN, "$1/[redacted]")
    .replace(INTERACTION_WEBHOOK_PATH_TOKEN_PATTERN, "$1/[redacted]");
}

function redactErrorMessage(error: unknown, botToken: string): string {
  const message = error instanceof Error ? error.message : "Discord bot request failed";
  return redactDiscordBotTokens(message, botToken);
}
