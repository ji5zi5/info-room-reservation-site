import { describe, expect, it } from "vitest";

import { interpretLoginJson, parseRiroProfileFromHtml } from "./riro-auth";

describe("riro auth parser", () => {
  it("returns a typed invalid credential result when RiroSchool returns 902", () => {
    expect(interpretLoginJson({ code: "902" })).toEqual({
      kind: "error",
      reason: "invalid_credentials",
      message: "아이디 또는 비밀번호가 틀렸습니다."
    });
  });

  it("parses a normal RiroSchool account profile", () => {
    const html = `
      <span class="m_level3">2학년 3반</span>
      <div class="input_disabled">홍길동</div>
      <div class="input_disabled">1-2345</div>
    `;

    expect(parseRiroProfileFromHtml({ html, loginId: "24012345" })).toEqual({
      kind: "success",
      profile: {
        generation: 31,
        name: "홍길동",
        role: "STUDENT",
        student: "2학년 3반",
        studentNumber: "12345"
      }
    });
  });

  it("parses an integrated RiroSchool account profile", () => {
    const html = `
      <div class="td_title">통합아이디</div>
      <div class="elem_fix">24012345 계정정보 1학년 2반)</div>
      <div class="input_disabled">김하늘</div>
      <div class="input_disabled">2-0789</div>
    `;

    expect(parseRiroProfileFromHtml({ html, loginId: "ignored" })).toEqual({
      kind: "success",
      profile: {
        generation: 31,
        name: "김하늘",
        role: "STUDENT",
        student: "1학년 2반",
        studentNumber: "20789"
      }
    });
  });
});
