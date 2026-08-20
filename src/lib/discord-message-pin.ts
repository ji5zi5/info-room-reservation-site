import ky, { HTTPError, TimeoutError } from "ky";

export type DiscordMessagePinResult =
  | { readonly kind: "pinned" }
  | { readonly code: string; readonly kind: "failed" };

export async function pinDiscordChannelMessage(input: {
  readonly botToken: string;
  readonly channelId: string;
  readonly messageId: string;
}): Promise<DiscordMessagePinResult> {
  try {
    await ky.put(
      `https://discord.com/api/v10/channels/${encodeURIComponent(input.channelId)}/pins/${encodeURIComponent(input.messageId)}`,
      {
        headers: { authorization: `Bot ${input.botToken}` },
        retry: { limit: 1, methods: ["put"], statusCodes: [408, 429, 500, 502, 503, 504] },
        timeout: 10_000
      }
    );
    return { kind: "pinned" };
  } catch (error) {
    if (error instanceof HTTPError) return { code: `discord_http_${error.response.status}`, kind: "failed" };
    if (error instanceof TimeoutError) return { code: "discord_timeout", kind: "failed" };
    if (error instanceof TypeError) return { code: "discord_network_error", kind: "failed" };
    throw error;
  }
}
