import { describe, expect, it } from "vitest";

import {
  DISCORD_ADMIN_COMMAND_NAMES,
  discordAdminCommandDefinitions
} from "./discord-admin-command-definition";

describe("Discord administrator command definitions", () => {
  it("registers separate top-level commands instead of an information-room command tree", () => {
    expect(discordAdminCommandDefinitions.map((definition) => definition.name)).toEqual(DISCORD_ADMIN_COMMAND_NAMES);
  });

  it("registers every planned command path exactly once", () => {
    const expected = [
      "현황", "명단",
      "예약/추가", "예약/취소", "예약/일괄취소",
      "학생/조회", "학생/제한", "학생/밴", "학생/블랙", "학생/해제",
      "설정/조회", "설정/시간", "설정/정원", "설정/활성",
      "알림/상태", "알림/신청", "알림/마감", "알림/마감전송",
      "운영/상태", "운영/미처리", "운영/동기화"
    ];

    const paths = discordAdminCommandDefinitions.flatMap((definition) =>
      definition.options.every((option) => option.type === 1)
        ? definition.options.map((option) => `${definition.name}/${option.name}`)
        : [definition.name]
    );

    expect(paths).toEqual(expected);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("places every required option before optional options", () => {
    const commandOptions = discordAdminCommandDefinitions.flatMap((definition) =>
      definition.options.every((option) => option.type === 1)
        ? definition.options
        : [{ ...definition, options: definition.options }]
    );

    for (const command of commandOptions) {
      const required = (command.options ?? []).map((option) => option.required === true);
      const firstOptional = required.indexOf(false);
      if (firstOptional >= 0) expect(required.slice(firstOptional)).not.toContain(true);
    }
  });
});
