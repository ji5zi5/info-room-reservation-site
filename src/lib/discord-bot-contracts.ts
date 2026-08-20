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

export type DiscordStringSelectComponent = {
  readonly custom_id: string;
  readonly max_values: 1;
  readonly min_values: 1;
  readonly options: readonly {
    readonly description: string;
    readonly label: string;
    readonly value: string;
  }[];
  readonly placeholder: string;
  readonly type: 3;
};

export type DiscordActionRowComponent = {
  readonly components: readonly (DiscordButtonComponent | DiscordStringSelectComponent)[];
  readonly type: 1;
};

export type DiscordBotMessagePayload = {
  readonly allowed_mentions: { readonly parse: readonly string[] };
  readonly components?: readonly DiscordActionRowComponent[];
  readonly enforce_nonce?: boolean;
  readonly embeds: readonly DiscordEmbed[];
  readonly nonce?: string;
};

export type DiscordBotDeliveryResult =
  | { readonly code: string; readonly kind: "failed"; readonly message: string; readonly outcome: "FAILED" }
  | { readonly kind: "sent"; readonly messageId: string }
  | {
      readonly code: "discord_invalid_response" | "discord_network_error" | "discord_timeout";
      readonly kind: "unknown";
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
  | { readonly kind: "found"; readonly messages: readonly { readonly id: string; readonly nonce: string | null }[] }
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
  readonly deleteChannelMessage: (input: { readonly channelId: string; readonly messageId: string }) => Promise<DiscordBotDeleteResult>;
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
