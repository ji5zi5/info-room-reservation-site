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

  it("returns a typed invalid credential result when RiroSchool returns current 400 response", () => {
    expect(
      interpretLoginJson({
        cid: "25000000",
        code: 400,
        data: { lock: false, set_app: [], url: "/user.php?action=signin" },
        msg: "아이디가 없거나 비밀번호가 맞지 않습니다. (2/5회 오류)",
        token: null
      })
    ).toEqual({
      kind: "error",
      reason: "invalid_credentials",
      message: "아이디가 없거나 비밀번호가 맞지 않습니다. (2/5회 오류)"
    });
  });

  it("returns a typed invalid credential result when RiroSchool returns current email login 200 response", () => {
    expect(
      interpretLoginJson({
        cid: "fake@gmail.com",
        code: 200,
        data: { lock: false, set_app: [], url: "/user.php?action=signin" },
        msg: "아이디가 없거나 비밀번호가 맞지 않습니다. (1/5회 오류)",
        token: null
      })
    ).toEqual({
      kind: "error",
      message: "아이디가 없거나 비밀번호가 맞지 않습니다. (1/5회 오류)",
      reason: "invalid_credentials"
    });
  });

  it("returns a typed invalid credential result when RiroSchool returns current email login 401 response", () => {
    expect(
      interpretLoginJson({
        cid: "student@gmail.com",
        code: 401,
        data: { lock: false, set_app: [], url: "/user.php?action=signin" },
        msg: "아이디가 없거나 비밀번호가 맞지 않습니다. (1/5회 오류)",
        token: null
      })
    ).toEqual({
      kind: "error",
      message: "아이디가 없거나 비밀번호가 맞지 않습니다. (1/5회 오류)",
      reason: "invalid_credentials"
    });
  });

  it("returns a typed invalid credential result when RiroSchool returns current 103 response", () => {
    expect(
      interpretLoginJson({
        code: 103,
        data: { lock: false, set_app: [], url: "/user.php?action=signin" },
        msg: "비밀번호를 다시 확인하세요. (2/5회 오류)",
        token: null
      })
    ).toEqual({
      kind: "error",
      message: "비밀번호를 다시 확인하세요. (2/5회 오류)",
      reason: "invalid_credentials"
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
