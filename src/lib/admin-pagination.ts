import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

export const ADMIN_PAGE_SIZE = 50;
export const ADMIN_CURSOR_TTL_MS = 15 * 60 * 1_000;

const CURSOR_VERSION = 1;
const HMAC_DOMAIN = "info-room/admin-pagination/cursor/v1";
const ResourceSchema = z.enum(["users", "reservations", "audits"]);
const IsoDateSchema = z.string().datetime({ offset: true });
const UserFiltersSchema = z.object({ bookingStatus: z.string(), query: z.string() }).strict();
const ReservationFiltersSchema = z.object({
  date: z.string().date(),
  query: z.string(),
  status: z.string(),
  studyPeriod: z.string(),
  userId: z.string().nullable()
}).strict();
const AuditFiltersSchema = z.object({ action: z.string(), query: z.string() }).strict();
const UserTupleSchema = z.object({ createdAt: IsoDateSchema, id: z.string().min(1) }).strict();
const ReservationTupleSchema = z.object({
  createdAt: IsoDateSchema,
  id: z.string().min(1),
  studyPeriod: z.enum(["EIGHTH", "FIRST"])
}).strict();
const AuditTupleSchema = UserTupleSchema;
const CursorPayloadSchema = z.discriminatedUnion("resource", [
  z.object({ cutoff: IsoDateSchema, exp: z.number().int(), filters: UserFiltersSchema, iat: z.number().int(), last: UserTupleSchema, resource: z.literal("users"), v: z.literal(CURSOR_VERSION) }).strict(),
  z.object({ cutoff: IsoDateSchema, exp: z.number().int(), filters: ReservationFiltersSchema, iat: z.number().int(), last: ReservationTupleSchema, resource: z.literal("reservations"), v: z.literal(CURSOR_VERSION) }).strict(),
  z.object({ cutoff: IsoDateSchema, exp: z.number().int(), filters: AuditFiltersSchema, iat: z.number().int(), last: AuditTupleSchema, resource: z.literal("audits"), v: z.literal(CURSOR_VERSION) }).strict()
]);

export type AdminCursorResource = z.infer<typeof ResourceSchema>;
export type AdminUserCursorFilters = z.infer<typeof UserFiltersSchema>;
export type AdminReservationCursorFilters = z.infer<typeof ReservationFiltersSchema>;
export type AdminAuditCursorFilters = z.infer<typeof AuditFiltersSchema>;
export type AdminUserCursorTuple = z.infer<typeof UserTupleSchema>;
export type AdminReservationCursorTuple = z.infer<typeof ReservationTupleSchema>;
export type AdminAuditCursorTuple = z.infer<typeof AuditTupleSchema>;
export type AdminCursorPayload = z.infer<typeof CursorPayloadSchema>;

type IssueCursorInput =
  | { readonly cutoff: Date; readonly filters: AdminUserCursorFilters; readonly last: AdminUserCursorTuple; readonly now: Date; readonly resource: "users"; readonly secret: string }
  | { readonly cutoff: Date; readonly filters: AdminReservationCursorFilters; readonly last: AdminReservationCursorTuple; readonly now: Date; readonly resource: "reservations"; readonly secret: string }
  | { readonly cutoff: Date; readonly filters: AdminAuditCursorFilters; readonly last: AdminAuditCursorTuple; readonly now: Date; readonly resource: "audits"; readonly secret: string };

type ParseCursorInput =
  | { readonly cursor: string; readonly filters: AdminUserCursorFilters; readonly now: Date; readonly resource: "users"; readonly secret: string }
  | { readonly cursor: string; readonly filters: AdminReservationCursorFilters; readonly now: Date; readonly resource: "reservations"; readonly secret: string }
  | { readonly cursor: string; readonly filters: AdminAuditCursorFilters; readonly now: Date; readonly resource: "audits"; readonly secret: string };

export const ADMIN_CURSOR_ERROR_CODES = [
  "CURSOR_EXPIRED",
  "CURSOR_FILTER_MISMATCH",
  "CURSOR_MALFORMED",
  "CURSOR_RESOURCE_MISMATCH",
  "CURSOR_TAMPERED",
  "CURSOR_SECRET_MISSING"
] as const;
export type AdminCursorErrorCode = (typeof ADMIN_CURSOR_ERROR_CODES)[number];

export class AdminCursorError extends Error {
  public override readonly name = "AdminCursorError";

  public constructor(public readonly code: AdminCursorErrorCode, message: string) {
    super(message);
  }
}

export function issueAdminCursor(input: IssueCursorInput): string {
  requireSecret(input.secret);
  const iat = input.now.getTime();
  const common = { cutoff: input.cutoff.toISOString(), exp: iat + ADMIN_CURSOR_TTL_MS, iat, v: CURSOR_VERSION } as const;
  const payload = CursorPayloadSchema.parse({ ...common, filters: input.filters, last: input.last, resource: input.resource });
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, input.secret)}`;
}

export function parseAdminCursor(input: ParseCursorInput): AdminCursorPayload {
  requireSecret(input.secret);
  const parts = input.cursor.split(".");
  if (parts.length !== 2) throw new AdminCursorError("CURSOR_MALFORMED", "cursor must contain a payload and signature");
  const encodedPayload = parts[0];
  const suppliedSignature = parts[1];
  if (!isCanonicalBase64Url(encodedPayload) || !isCanonicalBase64Url(suppliedSignature)) {
    throw new AdminCursorError("CURSOR_MALFORMED", "cursor is not canonical base64url");
  }
  const expectedSignature = sign(encodedPayload, input.secret);
  if (!safeEqual(suppliedSignature, expectedSignature)) {
    throw new AdminCursorError("CURSOR_TAMPERED", "cursor signature is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new AdminCursorError("CURSOR_MALFORMED", "cursor payload is not JSON");
    throw error;
  }
  const parsed = CursorPayloadSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.exp - parsed.data.iat !== ADMIN_CURSOR_TTL_MS || Date.parse(parsed.data.cutoff) > parsed.data.iat) {
    throw new AdminCursorError("CURSOR_MALFORMED", "cursor payload does not match version 1");
  }
  if (parsed.data.resource !== input.resource) throw new AdminCursorError("CURSOR_RESOURCE_MISMATCH", "cursor belongs to another resource");
  if (input.now.getTime() >= parsed.data.exp) throw new AdminCursorError("CURSOR_EXPIRED", "cursor expired");
  if (canonicalJson(parsed.data.filters) !== canonicalJson(input.filters)) {
    throw new AdminCursorError("CURSOR_FILTER_MISMATCH", "cursor filters changed");
  }
  return parsed.data;
}

export function sessionSecretForAdminCursor(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET;
  requireSecret(secret ?? "");
  return secret ?? "";
}

function requireSecret(secret: string): void {
  if (secret.length === 0) throw new AdminCursorError("CURSOR_SECRET_MISSING", "SESSION_SECRET is required");
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(HMAC_DOMAIN).update("\0").update(encodedPayload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isCanonicalBase64Url(value: string | undefined): value is string {
  if (value === undefined || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

function canonicalJson(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}
