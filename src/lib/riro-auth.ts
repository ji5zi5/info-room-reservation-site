import * as cheerio from "cheerio";
import ky, { type KyInstance } from "ky";
import { z } from "zod";

const LoginJsonSchema = z
  .object({
    code: z.union([z.string(), z.number()]).optional(),
    token: z.string().optional()
  })
  .passthrough();

export type RiroRole = "STUDENT" | "TEACHER";

export type RiroProfile = {
  readonly generation: number;
  readonly name: string;
  readonly role: RiroRole;
  readonly student: string;
  readonly studentNumber: string;
};

export type RiroAuthResult =
  | {
      readonly kind: "success";
      readonly profile: RiroProfile;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly reason: "invalid_credentials" | "bad_response" | "missing_token" | "parse_failed" | "network";
    };

type ParseProfileInput = {
  readonly html: string;
  readonly loginId: string;
};

type RiroHttpClient = Pick<KyInstance, "post">;

type LoginWithRiroInput = {
  readonly id: string;
  readonly password: string;
  readonly httpClient?: RiroHttpClient;
};

export function interpretLoginJson(input: unknown): RiroAuthResult | { readonly kind: "token"; readonly token: string } {
  const parsed = LoginJsonSchema.safeParse(input);
  if (!parsed.success) {
    return {
      kind: "error",
      message: "인증 서버에서 잘못된 응답을 받았습니다.",
      reason: "bad_response"
    };
  }

  const code = parsed.data.code === undefined ? "" : String(parsed.data.code);
  if (code === "902") {
    return {
      kind: "error",
      message: "아이디 또는 비밀번호가 틀렸습니다.",
      reason: "invalid_credentials"
    };
  }

  if (code !== "000") {
    return {
      kind: "error",
      message: `로그인 실패 code=${code}`,
      reason: "bad_response"
    };
  }

  if (!parsed.data.token) {
    return {
      kind: "error",
      message: "Token not found",
      reason: "missing_token"
    };
  }

  return {
    kind: "token",
    token: parsed.data.token
  };
}

export function parseRiroProfileFromHtml(input: ParseProfileInput): RiroAuthResult {
  const $ = cheerio.load(input.html);
  const isIntegrated = $(".td_title").first().text().trim() === "통합아이디";
  const name = $(".input_disabled").eq(0).text().trim();
  const studentNumber = normalizeStudentNumber($(".input_disabled").eq(1).text().trim());

  if (isIntegrated) {
    return parseIntegratedProfile($, input.loginId, name, studentNumber);
  }

  const student = firstNonEmptyText($, ["span.m_level3", "span.m_level1"]);
  return buildProfile({
    loginId: input.loginId,
    name,
    student,
    studentNumber
  });
}

export async function loginWithRiroSchool(input: LoginWithRiroInput): Promise<RiroAuthResult> {
  const httpClient = input.httpClient ?? ky.create({ timeout: 15_000 });

  try {
    await httpClient.post("https://iscience.riroschool.kr/user.php?action=user_logout", {
      throwHttpErrors: false,
      timeout: 10_000
    });

    const loginResponse = await httpClient
      .post("https://iscience.riroschool.kr/ajax.php", {
        body: new URLSearchParams({
          app: "user",
          deeplink: "",
          id: input.id,
          mode: "login",
          pw: input.password,
          redirect_link: "",
          userType: "1"
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome"
        },
        timeout: 15_000
      })
      .json<unknown>();

    const interpreted = interpretLoginJson(loginResponse);
    if (interpreted.kind !== "token") {
      return interpreted;
    }

    const profileHtml = await httpClient
      .post("https://iscience.riroschool.kr/user.php", {
        body: new URLSearchParams({ pw: input.password }),
        headers: {
          cookie: `cookie_token=${interpreted.token}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome"
        },
        redirect: "manual",
        timeout: 15_000
      })
      .text();

    return parseRiroProfileFromHtml({ html: profileHtml, loginId: input.id });
  } catch (error) {
    if (error instanceof Error) {
      return {
        kind: "error",
        message: "인증 서버와 통신 중 오류가 발생했습니다.",
        reason: "network"
      };
    }
    throw error;
  }
}

function parseIntegratedProfile(
  $: cheerio.CheerioAPI,
  fallbackLoginId: string,
  name: string,
  studentNumber: string
): RiroAuthResult {
  const accountText = $(".elem_fix").first().text().trim();
  const loginIdMatch = /^\d{8}/u.exec(accountText);
  const studentMatch = /(\d학년\s*\d반)/u.exec(accountText);
  const loginId = loginIdMatch?.[0] ?? fallbackLoginId;
  const student = studentMatch?.[1]?.trim() ?? "";

  return buildProfile({
    loginId,
    name,
    student,
    studentNumber
  });
}

function buildProfile(input: {
  readonly loginId: string;
  readonly name: string;
  readonly student: string;
  readonly studentNumber: string;
}): RiroAuthResult {
  const generation = calculateGeneration(input.loginId);
  if (!input.name || !input.studentNumber || !input.student || generation <= 0) {
    return {
      kind: "error",
      message: "인증 정보 파싱에 실패했습니다.",
      reason: "parse_failed"
    };
  }

  return {
    kind: "success",
    profile: {
      generation,
      name: input.name,
      role: input.studentNumber === "0" ? "TEACHER" : "STUDENT",
      student: input.student,
      studentNumber: input.studentNumber
    }
  };
}

function calculateGeneration(loginId: string): number {
  const prefix = loginId.slice(0, 2);
  if (!/^\d{2}$/u.test(prefix)) {
    return 0;
  }
  return Number.parseInt(`20${prefix}`, 10) - 1994 + 1;
}

function firstNonEmptyText($: cheerio.CheerioAPI, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const text = $(selector).first().text().trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeStudentNumber(raw: string): string {
  if (raw.length < 3) {
    return raw;
  }
  return `${raw.slice(0, 1)}${raw.slice(2)}`;
}
