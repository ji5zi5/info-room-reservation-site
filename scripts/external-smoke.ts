import path from "node:path";
import { fileURLToPath } from "node:url";

import ky from "ky";
import { z } from "zod";

const SESSION_COOKIE_NAME = "info_room_session";
const REQUEST_TIMEOUT_MS = 15_000;

const StudyPeriodSchema = z.union([z.literal("EIGHTH"), z.literal("FIRST")]);
const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const OptionalBooleanFlagSchema = z.preprocess(emptyStringToUndefined, z.enum(["true", "false"]).optional());
const OptionalIsoDateSchema = z.preprocess(emptyStringToUndefined, IsoDateSchema.optional());
const OptionalStringSchema = z.preprocess(emptyStringToUndefined, z.string().min(1).optional());
const OptionalStudyPeriodSchema = z.preprocess(emptyStringToUndefined, StudyPeriodSchema.optional());

const RawSmokeEnvSchema = z.object({
  RIRO_SMOKE_ID: z.string().min(1),
  RIRO_SMOKE_PASSWORD: z.string().min(1),
  SMOKE_ADMIN_ID: OptionalStringSchema,
  SMOKE_ADMIN_PASSWORD: OptionalStringSchema,
  SMOKE_BASE_URL: z.string().url(),
  SMOKE_CLOSED_LIST_DATE: OptionalIsoDateSchema,
  SMOKE_CLOSED_LIST_PERIOD: OptionalStudyPeriodSchema,
  SMOKE_CONFIRM_DISCORD_SEND: OptionalBooleanFlagSchema,
  SMOKE_FORCE_DISCORD_SEND: OptionalBooleanFlagSchema
});
const AdminSendEnvSchema = z.object({
  SMOKE_ADMIN_ID: z.string().min(1),
  SMOKE_ADMIN_PASSWORD: z.string().min(1),
  SMOKE_CLOSED_LIST_DATE: IsoDateSchema,
  SMOKE_CLOSED_LIST_PERIOD: StudyPeriodSchema,
  SMOKE_CONFIRM_DISCORD_SEND: z.literal("true"),
  SMOKE_FORCE_DISCORD_SEND: z.enum(["true", "false"]).optional()
});

const UserSchema = z.object({
  role: z.string(),
  studentNumber: z.string()
});
const LoginResponseSchema = z.object({ user: UserSchema });
const MeResponseSchema = z.object({ user: UserSchema.nullable() });
const CsrfResponseSchema = z.object({ csrfToken: z.string().min(1) });
const ClosedListSendResponseSchema = z.union([
  z.object({ kind: z.literal("sent") }).passthrough(),
  z.object({ kind: z.literal("failed") }).passthrough(),
  z.object({ kind: z.literal("skipped"), reason: z.string() }).passthrough()
]);

type SmokeConfig = {
  readonly adminSend: AdminSendConfig | null;
  readonly baseUrl: string;
  readonly riro: SmokeCredentials;
};

type SmokeCredentials = {
  readonly id: string;
  readonly password: string;
};

type AdminSendConfig = {
  readonly credentials: SmokeCredentials;
  readonly date: string;
  readonly force: boolean;
  readonly studyPeriod: z.infer<typeof StudyPeriodSchema>;
};

type SmokeCheck = {
  readonly detail?: string;
  readonly name: string;
  readonly status: "passed" | "skipped";
};

export class SmokeConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`External smoke configuration is incomplete: ${issues.join(", ")}`);
    this.issues = issues;
    this.name = "SmokeConfigError";
  }
}

export class SmokeStepError extends Error {
  readonly status: number | null;

  constructor(input: { readonly message: string; readonly status?: number }) {
    super(input.message);
    this.name = "SmokeStepError";
    this.status = input.status ?? null;
  }
}

export function parseSmokeEnv(source: Record<string, string | undefined>): SmokeConfig {
  const parsed = RawSmokeEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new SmokeConfigError(parsed.error.issues.map((issue) => issue.path.join(".")));
  }
  const adminSendRequested =
    parsed.data.SMOKE_ADMIN_ID !== undefined ||
    parsed.data.SMOKE_ADMIN_PASSWORD !== undefined ||
    parsed.data.SMOKE_CLOSED_LIST_DATE !== undefined ||
    parsed.data.SMOKE_CLOSED_LIST_PERIOD !== undefined ||
    parsed.data.SMOKE_CONFIRM_DISCORD_SEND === "true";
  return {
    adminSend: adminSendRequested ? parseAdminSendConfig(parsed.data) : null,
    baseUrl: normalizeBaseUrl(parsed.data.SMOKE_BASE_URL),
    riro: { id: parsed.data.RIRO_SMOKE_ID, password: parsed.data.RIRO_SMOKE_PASSWORD }
  };
}

export function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) {
    return null;
  }
  return new RegExp(`(?:^|,\\s*)(${SESSION_COOKIE_NAME}=[^;,]+)`, "u").exec(setCookieHeader)?.[1] ?? null;
}

export async function runExternalSmoke(config: SmokeConfig): Promise<readonly SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const login = await loginAndVerifyMe(config.baseUrl, config.riro);
  checks.push({ detail: `role=${login.role}`, name: "riro-login-and-api-me", status: "passed" });

  if (!config.adminSend) {
    checks.push({ detail: "set SMOKE_CONFIRM_DISCORD_SEND=true with admin/date/period to send", name: "discord-close-list-send", status: "skipped" });
    return checks;
  }

  const adminLogin = await loginAndVerifyMe(config.baseUrl, config.adminSend.credentials);
  if (adminLogin.role !== "ADMIN") {
    throw new SmokeStepError({ message: "SMOKE_ADMIN_ID did not authenticate as an admin user." });
  }
  const csrfToken = await fetchCsrfToken(config.baseUrl, adminLogin.cookie);
  const result = await postClosedListSend(config.baseUrl, adminLogin.cookie, csrfToken, config.adminSend);
  if (result.kind !== "sent") {
    throw new SmokeStepError({ message: `Closed-list Discord send did not finish as sent: ${JSON.stringify(result)}` });
  }
  checks.push({ detail: `${config.adminSend.date}:${config.adminSend.studyPeriod}`, name: "discord-close-list-send", status: "passed" });
  return checks;
}

function parseAdminSendConfig(data: z.infer<typeof RawSmokeEnvSchema>): AdminSendConfig {
  const parsed = AdminSendEnvSchema.safeParse(data);
  if (!parsed.success) {
    throw new SmokeConfigError(parsed.error.issues.map((issue) => issue.path.join(".")));
  }
  return {
    credentials: { id: parsed.data.SMOKE_ADMIN_ID, password: parsed.data.SMOKE_ADMIN_PASSWORD },
    date: parsed.data.SMOKE_CLOSED_LIST_DATE,
    force: parsed.data.SMOKE_FORCE_DISCORD_SEND !== "false",
    studyPeriod: parsed.data.SMOKE_CLOSED_LIST_PERIOD
  };
}

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

async function loginAndVerifyMe(baseUrl: string, credentials: SmokeCredentials): Promise<{ readonly cookie: string; readonly role: string }> {
  const loginResponse = await ky.post(endpoint(baseUrl, "/api/auth/riro/login"), {
    headers: sameOriginHeaders(baseUrl),
    json: { id: credentials.id, password: credentials.password },
    retry: 0,
    throwHttpErrors: false,
    timeout: REQUEST_TIMEOUT_MS
  });
  const loginPayload = await readJson(loginResponse);
  if (!loginResponse.ok) {
    throw new SmokeStepError({ message: `Riro login failed with HTTP ${loginResponse.status}: ${summarizeError(loginPayload)}`, status: loginResponse.status });
  }
  const parsedLogin = LoginResponseSchema.parse(loginPayload);
  const cookie = extractSessionCookie(loginResponse.headers.get("set-cookie"));
  if (!cookie) {
    throw new SmokeStepError({ message: "Login succeeded but session cookie was not set." });
  }

  const meResponse = await ky.get(endpoint(baseUrl, "/api/me"), {
    headers: { cookie },
    retry: 0,
    throwHttpErrors: false,
    timeout: REQUEST_TIMEOUT_MS
  });
  const parsedMe = MeResponseSchema.parse(await readJson(meResponse));
  if (!meResponse.ok || !parsedMe.user || parsedMe.user.studentNumber !== parsedLogin.user.studentNumber) {
    throw new SmokeStepError({ message: `/api/me did not return the logged-in Riro user.`, status: meResponse.status });
  }
  return { cookie, role: parsedLogin.user.role };
}

async function fetchCsrfToken(baseUrl: string, cookie: string): Promise<string> {
  const response = await ky.get(endpoint(baseUrl, "/api/csrf"), {
    headers: { cookie },
    retry: 0,
    throwHttpErrors: false,
    timeout: REQUEST_TIMEOUT_MS
  });
  if (!response.ok) {
    throw new SmokeStepError({ message: `CSRF token request failed with HTTP ${response.status}.`, status: response.status });
  }
  return CsrfResponseSchema.parse(await readJson(response)).csrfToken;
}

async function postClosedListSend(baseUrl: string, cookie: string, csrfToken: string, config: AdminSendConfig): Promise<z.infer<typeof ClosedListSendResponseSchema>> {
  const response = await ky.post(endpoint(baseUrl, "/api/admin/notifications/closed-periods/send"), {
    headers: { ...sameOriginHeaders(baseUrl), cookie, "x-csrf-token": csrfToken },
    json: { date: config.date, force: config.force, studyPeriod: config.studyPeriod },
    retry: 0,
    throwHttpErrors: false,
    timeout: REQUEST_TIMEOUT_MS
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new SmokeStepError({ message: `Closed-list send failed with HTTP ${response.status}: ${summarizeError(payload)}`, status: response.status });
  }
  return ClosedListSendResponseSchema.parse(payload);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    throw new SmokeStepError({ message: `Expected JSON response from ${response.url}, received an empty body.`, status: response.status });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SmokeStepError({ message: `Expected JSON response from ${response.url}, received invalid JSON.`, status: response.status });
    }
    throw error;
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}

function endpoint(baseUrl: string, pathname: string): string {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function sameOriginHeaders(baseUrl: string): Record<string, string> {
  return { origin: new URL(baseUrl).origin, "sec-fetch-site": "same-origin" };
}

function summarizeError(payload: unknown): string {
  const parsed = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(payload);
  return parsed.success ? `${parsed.data.error.code}: ${parsed.data.error.message}` : "unexpected response shape";
}

async function main(): Promise<void> {
  const checks = await runExternalSmoke(parseSmokeEnv(process.env));
  console.log(JSON.stringify({ checks, ok: true }, null, 2));
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    if (error instanceof SmokeConfigError || error instanceof SmokeStepError || error instanceof z.ZodError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  });
}
