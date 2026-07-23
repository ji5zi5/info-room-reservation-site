import { describe, expect, it } from "vitest";

import { adminSettingsSaveMessage } from "./admin-settings-save-result";

describe("adminSettingsSaveMessage", () => {
  it("returns a saved message Given both settings save When formatting the result Then the admin sees success", () => {
    expect(adminSettingsSaveMessage({ notificationsSaved: true, periodsSaved: true })).toBe("설정이 저장되었습니다.");
  });

  it("returns a notification failure message Given only periods save When formatting the result Then the admin sees the partial failure", () => {
    expect(adminSettingsSaveMessage({ notificationsSaved: false, periodsSaved: true })).toBe(
      "시간 설정은 저장됐지만 디스코드 알림 저장에 실패했습니다."
    );
  });

  it("returns a period failure message Given only notifications save When formatting the result Then the admin sees the partial failure", () => {
    expect(adminSettingsSaveMessage({ notificationsSaved: true, periodsSaved: false })).toBe(
      "디스코드 알림은 저장됐지만 시간 설정 저장에 실패했습니다."
    );
  });

  it("returns a combined failure message Given neither setting saves When formatting the result Then the admin sees both failed", () => {
    expect(adminSettingsSaveMessage({ notificationsSaved: false, periodsSaved: false })).toBe(
      "시간 설정과 디스코드 알림 저장에 실패했습니다."
    );
  });
});
