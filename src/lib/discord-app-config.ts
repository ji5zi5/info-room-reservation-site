const DISCORD_APPLICATION_ENV_KEYS = [
  "DISCORD_APPLICATION_ID",
  "DISCORD_PUBLIC_KEY",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_CHANNEL_ID",
  "DISCORD_ADMIN_ROLE_ID",
  "DISCORD_ADMIN_USER_MAP"
] as const;

const DISCORD_SNOWFLAKE_PATTERN = /^[1-9]\d{16,19}$/u;
const DISCORD_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/iu;
const STUDENT_NUMBER_PATTERN = /^\d{4,5}$/u;

export type DiscordApplicationConfig = {
  readonly adminRoleId: string;
  readonly adminUserBindings: readonly DiscordAdminUserBinding[];
  readonly applicationId: string;
  readonly botToken: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly publicKey: string;
};

export type DiscordAdminUserBinding = {
  readonly discordUserId: string;
  readonly studentNumber: string;
};

export type DiscordApplicationConfigInput = Readonly<Record<string, string | undefined>>;

export function parseDiscordApplicationConfig(raw: DiscordApplicationConfigInput): DiscordApplicationConfig | null {
  const applicationId = normalizeOptional(raw.DISCORD_APPLICATION_ID);
  const publicKey = normalizeOptional(raw.DISCORD_PUBLIC_KEY);
  const botToken = normalizeOptional(raw.DISCORD_BOT_TOKEN);
  const guildId = normalizeOptional(raw.DISCORD_GUILD_ID);
  const channelId = normalizeOptional(raw.DISCORD_CHANNEL_ID);
  const adminRoleId = normalizeOptional(raw.DISCORD_ADMIN_ROLE_ID);
  const adminUserMap = normalizeOptional(raw.DISCORD_ADMIN_USER_MAP);
  const values = {
    DISCORD_ADMIN_ROLE_ID: adminRoleId,
    DISCORD_ADMIN_USER_MAP: adminUserMap,
    DISCORD_APPLICATION_ID: applicationId,
    DISCORD_BOT_TOKEN: botToken,
    DISCORD_CHANNEL_ID: channelId,
    DISCORD_GUILD_ID: guildId,
    DISCORD_PUBLIC_KEY: publicKey
  } satisfies Record<(typeof DISCORD_APPLICATION_ENV_KEYS)[number], string | null>;
  const configuredKeyCount = DISCORD_APPLICATION_ENV_KEYS.filter((key) => values[key] !== null).length;

  if (configuredKeyCount === 0) {
    return null;
  }

  const missingKeys = DISCORD_APPLICATION_ENV_KEYS.filter((key) => values[key] === null);
  if (missingKeys.length > 0) {
    throw new DiscordApplicationConfigError(missingKeys);
  }

  const invalidKeys = [
    publicKey !== null && !DISCORD_PUBLIC_KEY_PATTERN.test(publicKey) ? "DISCORD_PUBLIC_KEY" : null,
    applicationId !== null && !isDiscordSnowflake(applicationId) ? "DISCORD_APPLICATION_ID" : null,
    guildId !== null && !isDiscordSnowflake(guildId) ? "DISCORD_GUILD_ID" : null,
    channelId !== null && !isDiscordSnowflake(channelId) ? "DISCORD_CHANNEL_ID" : null,
    adminRoleId !== null && !isDiscordSnowflake(adminRoleId) ? "DISCORD_ADMIN_ROLE_ID" : null
  ].filter((key): key is string => key !== null);
  const adminUserBindings = adminUserMap === null ? null : parseDiscordAdminUserBindings(adminUserMap);
  if (adminUserBindings === null) {
    invalidKeys.push("DISCORD_ADMIN_USER_MAP");
  }
  if (invalidKeys.length > 0) {
    throw new DiscordApplicationConfigError(invalidKeys);
  }

  if (
    applicationId === null ||
    publicKey === null ||
    botToken === null ||
    guildId === null ||
    channelId === null ||
    adminRoleId === null ||
    adminUserBindings === null
  ) {
    throw new DiscordApplicationConfigError(DISCORD_APPLICATION_ENV_KEYS);
  }

  return {
    adminRoleId,
    adminUserBindings,
    applicationId,
    botToken,
    channelId,
    guildId,
    publicKey
  };
}

export class DiscordApplicationConfigError extends Error {
  public constructor(readonly keys: readonly string[]) {
    super(`Invalid Discord application configuration: ${keys.join(", ")}`);
    this.name = "DiscordApplicationConfigError";
  }
}

function normalizeOptional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isDiscordSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE_PATTERN.test(value);
}

function parseDiscordAdminUserBindings(value: string): readonly DiscordAdminUserBinding[] | null {
  const bindings: DiscordAdminUserBinding[] = [];
  const discordUserIds = new Set<string>();
  const studentNumbers = new Set<string>();

  for (const entry of value.split(",")) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex !== entry.lastIndexOf(":")) {
      return null;
    }

    const discordUserId = entry.slice(0, separatorIndex).trim();
    const studentNumber = entry.slice(separatorIndex + 1).trim();
    if (
      !isDiscordSnowflake(discordUserId) ||
      !STUDENT_NUMBER_PATTERN.test(studentNumber) ||
      discordUserIds.has(discordUserId) ||
      studentNumbers.has(studentNumber)
    ) {
      return null;
    }

    discordUserIds.add(discordUserId);
    studentNumbers.add(studentNumber);
    bindings.push({ discordUserId, studentNumber });
  }

  return bindings.length > 0 ? bindings : null;
}
