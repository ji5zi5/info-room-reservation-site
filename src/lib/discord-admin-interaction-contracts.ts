import { z } from "zod";

import { parseDiscordAdminCommandData } from "./discord-admin-command-parser";
import {
  isDiscordAdminStudentSelectCustomId,
  parseDiscordAdminReasonCustomId,
  parseDiscordOperationsBoardCustomId,
  type DiscordOperationsBoardAction
} from "./discord-admin-custom-ids";
import { discordAdminReasonSchema, type DiscordAdminDraftIntent } from "./discord-admin-intents";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const interactionBaseSchema = z.object({
  application_id: snowflakeSchema,
  channel_id: snowflakeSchema,
  guild_id: snowflakeSchema,
  id: snowflakeSchema,
  member: z.object({
    roles: z.array(snowflakeSchema),
    user: z.object({ id: snowflakeSchema }).passthrough()
  }).passthrough(),
  token: z.string().min(1)
}).passthrough();
const commandInteractionSchema = interactionBaseSchema.extend({
  data: z.unknown(),
  type: z.literal(2)
});
const boardInteractionSchema = interactionBaseSchema.extend({
  data: z.object({ component_type: z.literal(2), custom_id: z.string().min(1).max(100) }).passthrough(),
  message: z.object({ id: snowflakeSchema }).passthrough(),
  type: z.literal(3)
});
const studentSelectInteractionSchema = interactionBaseSchema.extend({
  data: z.object({
    component_type: z.literal(3),
    custom_id: z.string().min(1).max(100),
    values: z.tuple([z.string().regex(/^\d{5}$/u)])
  }).passthrough(),
  type: z.literal(3)
});
const reasonModalSchema = interactionBaseSchema.extend({
  data: z.object({
    components: z.array(z.object({
      components: z.array(z.object({
        custom_id: z.literal("reason"),
        type: z.literal(4),
        value: z.string()
      }).passthrough()).min(1),
      type: z.literal(1)
    }).passthrough()).min(1),
    custom_id: z.string().min(1).max(100)
  }).passthrough(),
  type: z.literal(5)
});

type DiscordAdminInteractionSource = {
  readonly applicationId: string;
  readonly channelId: string;
  readonly discordUserId: string;
  readonly guildId: string;
  readonly interactionId: string;
  readonly interactionToken: string;
  readonly roleIds: readonly string[];
};

export type DiscordAdminInteraction =
  | { readonly kind: "invalid" }
  | (DiscordAdminInteractionSource & {
      readonly intent: DiscordAdminDraftIntent;
      readonly kind: "command";
    })
  | (DiscordAdminInteractionSource & {
      readonly kind: "reason_submit";
      readonly reason: string;
      readonly sourceInteractionId: string;
    })
  | (DiscordAdminInteractionSource & {
      readonly action: DiscordOperationsBoardAction;
      readonly kind: "board_component";
      readonly messageId: string;
      readonly revision: number;
    });

export function parseDiscordAdminInteraction(
  input: unknown,
  secret: string = process.env.DISCORD_BOT_TOKEN ?? "",
  now: Date = new Date()
): DiscordAdminInteraction {
  const command = commandInteractionSchema.safeParse(input);
  if (command.success) {
    const intent = parseDiscordAdminCommandData(command.data.data, now);
    return intent === null ? { kind: "invalid" } : { ...sourceFields(command.data), intent, kind: "command" };
  }

  const studentSelect = studentSelectInteractionSchema.safeParse(input);
  if (studentSelect.success) {
    return isDiscordAdminStudentSelectCustomId(studentSelect.data.data.custom_id, secret)
      ? {
          ...sourceFields(studentSelect.data),
          intent: { kind: "student_lookup", query: studentSelect.data.data.values[0] },
          kind: "command"
        }
      : { kind: "invalid" };
  }

  const board = boardInteractionSchema.safeParse(input);
  if (board.success) {
    const control = parseDiscordOperationsBoardCustomId(board.data.data.custom_id, secret);
    return control === null
      ? { kind: "invalid" }
      : {
          ...sourceFields(board.data),
          action: control.action,
          kind: "board_component",
          messageId: board.data.message.id,
          revision: control.revision
        };
  }

  const modal = reasonModalSchema.safeParse(input);
  if (!modal.success) return { kind: "invalid" };
  const sourceInteractionId = parseDiscordAdminReasonCustomId(modal.data.data.custom_id, secret);
  const reason = parseReason(modal.data.data.components);
  return sourceInteractionId === null || reason === null
    ? { kind: "invalid" }
    : { ...sourceFields(modal.data), kind: "reason_submit", reason, sourceInteractionId };
}

function sourceFields(interaction: z.infer<typeof interactionBaseSchema>): DiscordAdminInteractionSource {
  return {
    applicationId: interaction.application_id,
    channelId: interaction.channel_id,
    discordUserId: interaction.member.user.id,
    guildId: interaction.guild_id,
    interactionId: interaction.id,
    interactionToken: interaction.token,
    roleIds: interaction.member.roles
  };
}

function parseReason(rows: readonly {
  readonly components: readonly { readonly custom_id: "reason"; readonly type: 4; readonly value: string }[];
}[]): string | null {
  const reasons = rows.flatMap((row) => row.components.map((component) => component.value));
  const parsed = reasons.length === 1 ? discordAdminReasonSchema.safeParse(reasons[0]) : null;
  return parsed?.success === true ? parsed.data : null;
}
