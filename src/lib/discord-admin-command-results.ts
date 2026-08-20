import { z } from "zod";

import type { DiscordBotMessagePayload } from "./discord-bot";

const fieldSchema = z.object({ inline: z.boolean(), name: z.string().max(256), value: z.string().max(1024) });
const selectRowSchema = z.object({
  components: z.array(z.object({
    custom_id: z.string().min(1).max(100),
    max_values: z.literal(1),
    min_values: z.literal(1),
    options: z.array(z.object({
      description: z.string().max(100),
      label: z.string().max(100),
      value: z.string().max(100)
    })).min(1).max(25),
    placeholder: z.string().max(150),
    type: z.literal(3)
  })).length(1),
  type: z.literal(1)
});
export const discordAdminCommandResultSchema = z.object({
  color: z.number().int().min(0).max(0xffffff),
  components: z.array(selectRowSchema).max(5).optional(),
  description: z.string().max(4096),
  fields: z.array(fieldSchema).max(25),
  outcome: z.union([z.literal("failure"), z.literal("stale"), z.literal("success")]),
  title: z.string().max(256)
});

export type DiscordAdminCommandResult = z.infer<typeof discordAdminCommandResultSchema>;

export function buildDiscordAdminResultPayload(result: DiscordAdminCommandResult): DiscordBotMessagePayload {
  return {
    allowed_mentions: { parse: [] },
    ...(result.components === undefined ? {} : { components: result.components }),
    embeds: [{
      color: result.color,
      description: result.description,
      fields: result.fields,
      title: result.title
    }]
  };
}

export function discordAdminSuccessResult(input: {
  readonly components?: DiscordAdminCommandResult["components"];
  readonly description: string;
  readonly fields?: readonly { readonly inline: boolean; readonly name: string; readonly value: string }[];
  readonly title: string;
}): DiscordAdminCommandResult {
  return {
    color: 0x57f287,
    ...(input.components === undefined ? {} : { components: input.components }),
    description: input.description,
    fields: [...(input.fields ?? [])],
    outcome: "success",
    title: input.title
  };
}

export function discordAdminStaleResult(input: {
  readonly description: string;
  readonly title: string;
}): DiscordAdminCommandResult {
  return { color: 0xfee75c, description: input.description, fields: [], outcome: "stale", title: input.title };
}

export function discordAdminFailureResult(input: {
  readonly description: string;
  readonly title: string;
}): DiscordAdminCommandResult {
  return { color: 0xed4245, description: input.description, fields: [], outcome: "failure", title: input.title };
}
