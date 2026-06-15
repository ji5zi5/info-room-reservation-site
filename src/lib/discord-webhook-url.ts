const DISCORD_WEBHOOK_HOSTS = ["discord.com", "discordapp.com"] as const;

type DiscordWebhookUrlValidationFailure = "invalid-url" | "protocol" | "host" | "path";

export class InvalidDiscordWebhookUrlError extends Error {
  public constructor(readonly reason: DiscordWebhookUrlValidationFailure) {
    super(`Invalid Discord webhook URL: ${reason}`);
    this.name = "InvalidDiscordWebhookUrlError";
  }
}

export function isDiscordWebhookUrl(value: string): boolean {
  try {
    parseDiscordWebhookUrl(value);
    return true;
  } catch (error) {
    if (error instanceof InvalidDiscordWebhookUrlError) {
      return false;
    }
    throw error;
  }
}

export function parseDiscordWebhookUrl(webhookUrl: string): URL {
  const url = parseUrl(webhookUrl);
  if (url.protocol !== "https:") {
    throw new InvalidDiscordWebhookUrlError("protocol");
  }
  if (!isDiscordWebhookHost(url.host)) {
    throw new InvalidDiscordWebhookUrlError("host");
  }
  if (!isDiscordWebhookPath(url.pathname)) {
    throw new InvalidDiscordWebhookUrlError("path");
  }
  return url;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new InvalidDiscordWebhookUrlError("invalid-url");
    }
    throw error;
  }
}

function isDiscordWebhookHost(host: string): boolean {
  return DISCORD_WEBHOOK_HOSTS.some((discordHost) => discordHost === host);
}

function isDiscordWebhookPath(pathname: string): boolean {
  const pathSegments = pathname.split("/");
  if (pathSegments.length !== 5) {
    return false;
  }

  const [, apiSegment, webhooksSegment, idSegment, tokenSegment] = pathSegments;
  return (
    apiSegment === "api" &&
    webhooksSegment === "webhooks" &&
    idSegment !== undefined &&
    idSegment.length > 0 &&
    tokenSegment !== undefined &&
    tokenSegment.length > 0
  );
}
