import { describe, expect, it } from "vitest";

import { buildDiscordAdminResultPayload } from "./discord-admin-command-results";
import { formatDiscordAdminReadResult } from "./discord-admin-read-result-formatter";

describe("Discord administrator result formatters", () => {
  it("offers a student selection menu for ambiguous searches", () => {
    const result = formatDiscordAdminReadResult({
      intent: { kind: "student_lookup", query: "엄" },
      result: {
        kind: "students",
        students: [student("31001", "엄지오"), student("31002", "엄다른")]
      },
      secret: "test-discord-secret"
    });

    expect(buildDiscordAdminResultPayload(result).components).toEqual([{
      components: [expect.objectContaining({
        options: [
          { description: "31001", label: "엄지오", value: "31001" },
          { description: "31002", label: "엄다른", value: "31002" }
        ],
        placeholder: "학생을 선택하세요",
        type: 3
      })],
      type: 1
    }]);
  });
});

function student(studentNumber: string, name: string) {
  return {
    bookingStatus: "ACTIVE",
    id: `student-${studentNumber}`,
    name,
    recentReservations: [],
    restrictedUntil: null,
    restrictionReason: null,
    shadowBanProfile: "NORMAL",
    studentNumber
  };
}
