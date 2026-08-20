import { describe, expect, it } from "vitest";

import { discordInfoRoomCommandDefinition } from "./discord-admin-command-definition";

describe("Discord information-room command definition", () => {
  it("registers every planned command path exactly once", () => {
    // Given: the guild command registration definition.
    const expected = [
      "현황", "명단",
      "예약/추가", "예약/취소", "예약/일괄취소",
      "학생/조회", "학생/제한", "학생/밴", "학생/블랙", "학생/해제",
      "설정/조회", "설정/시간", "설정/정원", "설정/활성",
      "알림/상태", "알림/신청", "알림/마감", "알림/마감전송",
      "운영/상태", "운영/미처리", "운영/동기화"
    ];

    // When: its command paths are enumerated.
    const paths = discordInfoRoomCommandDefinition.options.flatMap((option) =>
      option.type === 2
        ? (option.options ?? []).map((child) => `${option.name}/${child.name}`)
        : [option.name]
    );

    // Then: Discord exposes the complete operator surface without duplicates.
    expect(paths).toEqual(expected);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("places every required option before optional options", () => {
    const commandOptions = discordInfoRoomCommandDefinition.options.flatMap((option) =>
      option.type === 2 ? option.options ?? [] : [option]
    );

    for (const command of commandOptions) {
      const required = (command.options ?? []).map((option) => option.required === true);
      const firstOptional = required.indexOf(false);
      if (firstOptional >= 0) expect(required.slice(firstOptional)).not.toContain(true);
    }
  });
});
