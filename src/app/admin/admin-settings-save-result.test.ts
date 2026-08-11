import { describe, expect, it } from "vitest";

import { adminSettingsSaveMessage } from "./admin-settings-save-result";

const ok = { data: {}, kind: "ok" } as const;
const periodError = {
  kind: "error",
  message: "시간대 설정 저장에 실패했습니다.",
  retryAfterMs: null,
  retryable: false,
  status: 400
} as const;
const notificationError = {
  kind: "error",
  message: "알림 설정 저장에 실패했습니다.",
  retryAfterMs: 1_001,
  retryable: true,
  status: 503
} as const;

describe("adminSettingsSaveMessage", () => {
  it("returns a saved message Given both settings save When formatting the result Then the admin sees success", () => {
    expect(adminSettingsSaveMessage({ notifications: ok, periods: ok })).toBe("설정이 저장되었습니다.");
  });

  it("returns a notification failure message Given only periods save When formatting the result Then the admin sees the partial failure", () => {
    expect(adminSettingsSaveMessage({ notifications: notificationError, periods: ok })).toBe(
      "시간대는 저장되었습니다. 디스코드: 알림 설정 저장에 실패했습니다. 2초 후 다시 시도해 주세요."
    );
  });

  it("returns a period failure message Given only notifications save When formatting the result Then the admin sees the partial failure", () => {
    expect(adminSettingsSaveMessage({ notifications: ok, periods: periodError })).toBe(
      "디스코드 알림은 저장되었습니다. 시간대: 시간대 설정 저장에 실패했습니다."
    );
  });

  it("returns a combined failure message Given neither setting saves When formatting the result Then the admin sees both failed", () => {
    expect(adminSettingsSaveMessage({ notifications: notificationError, periods: periodError })).toBe(
      "시간대: 시간대 설정 저장에 실패했습니다. 디스코드: 알림 설정 저장에 실패했습니다. 2초 후 다시 시도해 주세요."
    );
  });
});
