import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  parseDiscordApplicationConfig,
  type DiscordApplicationConfig,
  type DiscordApplicationConfigInput
} from "../src/lib/discord-app-config";
import { createDiscordBotClient, redactDiscordBotTokens, type DiscordBotClient } from "../src/lib/discord-bot";
import {
  createFencedDiscordDisable,
  reenableDiscordOperations,
  type DisableDiscordPendingResult,
  type DiscordDisablePendingRepository,
  type DiscordOperationsFenceRepository
} from "../src/lib/discord-disable-pending";
import { prismaDiscordReservationMaintenanceRepository } from "../src/lib/prisma-discord-reservation-maintenance-repository";
import { loadDiscordReservationSnapshot, type DiscordReservationSnapshotResult } from "../src/lib/discord-reservation-snapshot";
import { createPrismaDiscordOperationsFenceRuntime } from "./operational-rollout-smoke";

const CONFIRMATION = "DISABLE_DISCORD_INTERACTIONS";
const REENABLE_CONFIRMATION = "ENABLE_DISCORD_INTERACTIONS";
const RESIDUAL_ACKNOWLEDGEMENT = "ACKNOWLEDGE_RESIDUAL_INERT_CONTROLS";
const FixtureSchema = z.enum(["active"]);

type CliCommand = {
  readonly confirm: typeof CONFIRMATION;
  readonly fixture: z.infer<typeof FixtureSchema> | null;
} | {
  readonly acknowledgeResidualInertControls: true;
  readonly confirm: typeof REENABLE_CONFIRMATION;
  readonly fixture: z.infer<typeof FixtureSchema> | null;
};

type DisableRuntime = {
  readonly bot: Pick<DiscordBotClient, "editChannelMessage">;
  readonly config: DiscordApplicationConfig;
  readonly loadSnapshot: (reservationId: string) => Promise<DiscordReservationSnapshotResult>;
  readonly operations: DiscordOperationsFenceRepository;
  readonly repository: DiscordDisablePendingRepository;
  readonly close?: () => Promise<void>;
};

type CliOptions = {
  readonly args: readonly string[];
  readonly env?: DiscordApplicationConfigInput;
  readonly now?: Date;
  readonly runtimeFactory?: (config: DiscordApplicationConfig, fixture: CliCommand["fixture"]) => DisableRuntime;
  readonly stderr?: (line: string) => void;
  readonly stdout?: (line: string) => void;
};

export async function runDisableDiscordPendingCli(options: CliOptions): Promise<number> {
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  let token = "";
  let runtime: DisableRuntime | undefined;
  try {
    const command = parseCommand(options.args);
    const env = command.fixture === null ? (options.env ?? process.env) : fixtureEnvironment();
    const config = parseDiscordApplicationConfig(env);
    if (config === null) {
      throw new DiscordDisableConfigurationError();
    }
    token = config.botToken;
    runtime = (options.runtimeFactory ?? createRuntime)(config, command.fixture);
    if ("acknowledgeResidualInertControls" in command) {
      const control = await reenableDiscordOperations({
        acknowledgeResidualInertControls: true,
        now: options.now ?? new Date(),
        repository: runtime.operations
      });
      stdout(JSON.stringify({ event: "discord_interactions_enabled", ...control }));
      return 0;
    }
    const result = await createFencedDiscordDisable({
      bot: runtime.bot,
      loadSnapshot: runtime.loadSnapshot,
      operations: runtime.operations,
      repository: runtime.repository
    })({ now: options.now ?? new Date() });
    stdout(JSON.stringify({ event: "discord_interactions_disabled", ...result }));
    return result.failed === 0 && !result.hasMore ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discord rollback failed";
    stderr(JSON.stringify({
      error: token === "" ? message : redactDiscordBotTokens(message, token),
      event: "discord_interactions_disable_failed"
    }));
    return 1;
  } finally {
    await runtime?.close?.();
  }
}

export function parseCommand(args: readonly string[]): CliCommand {
  let confirm: string | null = null;
  let fixture: string | null = null;
  let acknowledgement: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--confirm") {
      confirm = value ?? null;
      continue;
    }
    if (flag === "--fixture") {
      fixture = value ?? null;
      continue;
    }
    if (flag === "--acknowledge-residual-controls") {
      acknowledgement = value ?? null;
      continue;
    }
    throw new DiscordDisableConfirmationError();
  }
  if (confirm === REENABLE_CONFIRMATION && acknowledgement === RESIDUAL_ACKNOWLEDGEMENT) {
    return { acknowledgeResidualInertControls: true, confirm, fixture: fixture === null ? null : FixtureSchema.parse(fixture) };
  }
  if (confirm !== CONFIRMATION || acknowledgement !== null) {
    throw new DiscordDisableConfirmationError();
  }
  return { confirm: CONFIRMATION, fixture: fixture === null ? null : FixtureSchema.parse(fixture) };
}

function createRuntime(config: DiscordApplicationConfig, fixture: CliCommand["fixture"]): DisableRuntime {
  if (fixture === "active") {
    return fixtureRuntime(config);
  }
  const operationsRuntime = createPrismaDiscordOperationsFenceRuntime(requireDirectUrl());
  return {
    bot: createDiscordBotClient({ applicationId: config.applicationId, botToken: config.botToken }),
    close: operationsRuntime.close,
    config,
    loadSnapshot: loadDiscordReservationSnapshot,
    operations: operationsRuntime.repository,
    repository: prismaDiscordReservationMaintenanceRepository
  };
}

function fixtureRuntime(config: DiscordApplicationConfig): DisableRuntime {
  let claimed = false;
  return {
    bot: {
      editChannelMessage: async ({ messageId }) => ({ kind: "sent", messageId })
    },
    config,
    loadSnapshot: async () => fixtureSnapshot(),
    operations: fixtureOperationsRepository(),
    repository: {
      claimActiveMessagesForDisable: async () => {
        if (claimed) {
          return [];
        }
        claimed = true;
        return [{ channelId: config.channelId, claimId: "fixture-claim", messageId: "fixture-message", reservationId: "fixture-reservation", revision: 0 }];
      },
      completeDisableClaim: async () => true,
      releaseDisableClaim: async () => true
    }
  };
}

function fixtureOperationsRepository(): DiscordOperationsFenceRepository {
  return {
    beginDisable: async () => ({ epoch: 1, preFenceTransportCount: 0 }),
    countOldReservationMutations: async () => 0,
    reenable: async () => ({ control: { enabled: true, epoch: 2, pendingRemoteCleanup: false }, kind: "enabled" }),
    setPendingRemoteCleanup: async () => undefined
  };
}

function requireDirectUrl(): string {
  const directUrl = process.env.DIRECT_URL;
  if (directUrl === undefined || directUrl.trim() === "") throw new DiscordDisableConfigurationError();
  return directUrl;
}

function fixtureEnvironment(): DiscordApplicationConfigInput {
  return {
    DISCORD_ADMIN_ROLE_ID: "123456789012345678",
    DISCORD_ADMIN_USER_MAP: "234567890123456789:12345",
    DISCORD_APPLICATION_ID: "345678901234567890",
    DISCORD_BOT_TOKEN: "fixture-bot-token",
    DISCORD_CHANNEL_ID: "456789012345678901",
    DISCORD_GUILD_ID: "567890123456789012",
    DISCORD_PUBLIC_KEY: "a".repeat(64)
  };
}

function fixtureSnapshot(): DiscordReservationSnapshotResult {
  return {
    kind: "ready",
    snapshot: {
      capacity: 10,
      closeAtUnix: 1_786_419_000,
      confirmedCount: 4,
      effectiveSetting: {
        capacity: 10,
        closeTime: "16:30",
        date: "2026-08-11",
        enabled: true,
        openTime: "08:00",
        studyPeriod: "EIGHTH"
      },
      remaining: 6,
      reservation: {
        date: "2026-08-11",
        id: "fixture-reservation",
        reason: "fixture",
        status: "CONFIRMED",
        studyPeriod: "EIGHTH",
        user: { id: "fixture-user", name: "Fixture", studentNumber: "12345" },
        userId: "fixture-user"
      }
    }
  };
}

class DiscordDisableConfirmationError extends Error {
  public constructor() {
    super(`Explicit confirmation required: --confirm ${CONFIRMATION}`);
    this.name = "DiscordDisableConfirmationError";
  }
}

class DiscordDisableConfigurationError extends Error {
  public constructor() {
    super("Complete Discord application configuration is required");
    this.name = "DiscordDisableConfigurationError";
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  runDisableDiscordPendingCli({ args: process.argv.slice(2) }).then((exitCode) => {
    process.exitCode = exitCode;
  });
}

export type { DisableRuntime, DisableDiscordPendingResult };
