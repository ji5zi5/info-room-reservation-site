import { after } from "next/server";

import type { DiscordApplicationConfig } from "./discord-app-config";
import { syncDiscordOperationsBoard } from "./discord-operations-board-service";
import { parseServerEnv } from "./env";
import { requestDiscordOperationsBoardSync } from "./prisma-discord-operations-board";

export function scheduleDiscordOperationsBoardSync(): void {
  const config = readDiscordApplicationConfig();
  if (config === null) return;

  after(() => syncDiscordOperationsBoardAfterMutation(new Date(), config));
}

export async function syncDiscordOperationsBoardAfterMutation(
  now = new Date(),
  configuredApplication?: DiscordApplicationConfig
): Promise<void> {
  const config = configuredApplication ?? readDiscordApplicationConfig();
  if (config === null) return;

  try {
    await requestDiscordOperationsBoardSync(now);
    const result = await syncDiscordOperationsBoard({ config, force: true, now });
    if (result.kind === "failed") {
      reportBoardSyncFailure(result.code);
    }
  } catch (error) {
    if (error instanceof Error) {
      reportBoardSyncFailure(error.name);
      return;
    }
    throw error;
  }
}

function readDiscordApplicationConfig(): DiscordApplicationConfig | null {
  try {
    return parseServerEnv().discordApplication;
  } catch (error) {
    if (error instanceof Error) {
      reportBoardSyncFailure(error.name);
      return null;
    }
    throw error;
  }
}

function reportBoardSyncFailure(code: string): void {
  console.error(JSON.stringify({ code: safeIdentifier(code), event: "discord_operations_board_sync_failed" }));
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : "unknown_error";
}
