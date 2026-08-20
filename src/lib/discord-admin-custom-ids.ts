import { createHmac, timingSafeEqual } from "node:crypto";

const SNOWFLAKE_PATTERN = /^\d{17,20}$/u;
const CUSTOM_ID_MAX_LENGTH = 100;

export type DiscordOperationsBoardAction = "backlog" | "refresh" | "roster_eighth" | "roster_first";

export function buildDiscordAdminReasonCustomId(input: {
  readonly secret: string;
  readonly sourceInteractionId: string;
}): string {
  if (!SNOWFLAKE_PATTERN.test(input.sourceInteractionId) || input.secret.length === 0) {
    throw new InvalidDiscordAdminCustomIdError();
  }
  const body = `da1.${input.sourceInteractionId}`;
  return `${body}.${mac("reason", body, input.secret)}`;
}

export function parseDiscordAdminReasonCustomId(customId: string, secret: string): string | null {
  const [version, sourceInteractionId, signature, extra] = customId.split(".");
  const body = `${version}.${sourceInteractionId}`;
  return version === "da1" && sourceInteractionId !== undefined && signature !== undefined && extra === undefined &&
    SNOWFLAKE_PATTERN.test(sourceInteractionId) && secureEqual(signature, mac("reason", body, secret))
    ? sourceInteractionId
    : null;
}

export function buildDiscordAdminStudentSelectCustomId(input: { readonly secret: string }): string {
  if (input.secret.length === 0) throw new InvalidDiscordAdminCustomIdError();
  const body = "ds1.student";
  return `${body}.${mac("student", body, input.secret)}`;
}

export function isDiscordAdminStudentSelectCustomId(customId: string, secret: string): boolean {
  const [version, action, signature, extra] = customId.split(".");
  const body = `${version}.${action}`;
  return version === "ds1" && action === "student" && signature !== undefined && extra === undefined &&
    secureEqual(signature, mac("student", body, secret));
}

export function buildDiscordOperationsBoardCustomId(input: {
  readonly action: DiscordOperationsBoardAction;
  readonly revision: number;
  readonly secret: string;
}): string {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.secret.length === 0) {
    throw new InvalidDiscordAdminCustomIdError();
  }
  const body = `db1.${boardActionCode(input.action)}.${input.revision.toString(36)}`;
  const customId = `${body}.${mac("board", body, input.secret)}`;
  if (customId.length > CUSTOM_ID_MAX_LENGTH) throw new InvalidDiscordAdminCustomIdError();
  return customId;
}

export function parseDiscordOperationsBoardCustomId(
  customId: string,
  secret: string
): { readonly action: DiscordOperationsBoardAction; readonly revision: number } | null {
  const [version, actionCode, revisionText, signature, extra] = customId.split(".");
  if (version !== "db1" || actionCode === undefined || revisionText === undefined || signature === undefined ||
      extra !== undefined || !/^[0-9a-z]+$/u.test(revisionText)) return null;
  const action = boardAction(actionCode);
  const revision = Number.parseInt(revisionText, 36);
  const body = `${version}.${actionCode}.${revisionText}`;
  return action !== null && Number.isSafeInteger(revision) && revision >= 0 &&
    secureEqual(signature, mac("board", body, secret))
    ? { action, revision }
    : null;
}

function mac(context: "board" | "reason" | "student", body: string, secret: string): string {
  return createHmac("sha256", secret).update(`discord-admin-${context}:v1\0${body}`).digest("base64url").slice(0, 22);
}

function secureEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function boardActionCode(action: DiscordOperationsBoardAction): string {
  switch (action) {
    case "refresh": return "r";
    case "roster_eighth": return "8";
    case "roster_first": return "1";
    case "backlog": return "b";
    default: return assertNever(action);
  }
}

function boardAction(code: string): DiscordOperationsBoardAction | null {
  switch (code) {
    case "r": return "refresh";
    case "8": return "roster_eighth";
    case "1": return "roster_first";
    case "b": return "backlog";
    default: return null;
  }
}

function assertNever(value: never): never {
  throw new InvalidDiscordAdminCustomIdError(String(value));
}

class InvalidDiscordAdminCustomIdError extends Error {
  public override readonly name = "InvalidDiscordAdminCustomIdError";

  public constructor(value: string = "invalid") {
    super(`Invalid Discord administrator custom ID: ${value}`);
  }
}
