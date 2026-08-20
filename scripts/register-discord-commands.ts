import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ky, { HTTPError } from "ky";
import { z } from "zod";

import { DiscordApplicationConfigError, parseDiscordApplicationConfig } from "../src/lib/discord-app-config";
import { discordInfoRoomCommandDefinition } from "../src/lib/discord-admin-command-definition";

const responseSchema = z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }));

export async function registerDiscordCommands(rawEnvironment: Readonly<Record<string, string | undefined>>): Promise<readonly {
  readonly id: string;
  readonly name: string;
}[]> {
  const config = parseDiscordApplicationConfig(rawEnvironment);
  if (config === null) throw new DiscordCommandRegistrationError("Discord application configuration is required.");
  const response = await ky.put(
    `https://discord.com/api/v10/applications/${encodeURIComponent(config.applicationId)}/guilds/${encodeURIComponent(config.guildId)}/commands`,
    {
      headers: { authorization: `Bot ${config.botToken}` },
      json: [discordInfoRoomCommandDefinition],
      retry: { limit: 1, methods: ["put"], statusCodes: [408, 429, 500, 502, 503, 504] },
      timeout: 10_000
    }
  ).json<unknown>();
  return responseSchema.parse(response);
}

class DiscordCommandRegistrationError extends Error {
  public override readonly name = "DiscordCommandRegistrationError";
}

async function runCli(): Promise<void> {
  try {
    const registered = await registerDiscordCommands(process.env);
    console.log(`Registered Discord guild commands: ${registered.map((command) => `/${command.name}`).join(", ")}`);
  } catch (error) { // no-excuse-ok: catch -- CLI boundary redacts Discord credentials and response bodies.
    if (error instanceof DiscordApplicationConfigError || error instanceof DiscordCommandRegistrationError) {
      console.error(error.message);
    } else if (error instanceof HTTPError) {
      console.error(`Discord command registration failed with HTTP ${error.response.status}.`);
    } else if (error instanceof z.ZodError) {
      console.error("Discord returned an invalid command registration response.");
    } else {
      console.error("Discord command registration failed unexpectedly.");
    }
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) void runCli();
