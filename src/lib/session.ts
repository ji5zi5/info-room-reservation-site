import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { cookies } from "next/headers";
import { z } from "zod";

import { prisma } from "./db";
import { systemDatabaseActor, withDatabaseContext } from "./db-context";
import { isNoDatabaseMockMode } from "./mock-dev-mode";
import { hashServerSecretValue } from "./secret-hash";
import { DEFAULT_SHADOW_BAN_PROFILE } from "./shadow-ban-profile";

export const SESSION_COOKIE_NAME = "info_room_session";

const SESSION_TTL_DAYS = 14;
const MOCK_SESSION_TOKEN_PREFIX = "mock.";

export type SessionUser = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: string | null;
  readonly role: string;
  readonly shadowBanProfile?: string;
  readonly studentNumber: string;
};

export type CurrentSession = {
  readonly id: string;
  readonly user: SessionUser;
};

const SessionUserSchema = z.object({
  bookingStatus: z.string(),
  generation: z.number(),
  id: z.string(),
  name: z.string(),
  restrictionReason: z.string().nullable().optional(),
  restrictedUntil: z.string().nullable().optional(),
  role: z.string(),
  shadowBanProfile: z.string().optional(),
  studentNumber: z.string()
});

const MockSessionPayloadSchema = z.object({
  id: z.string(),
  user: SessionUserSchema
});

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: async (transaction) => {
      await transaction.session.create({
        data: {
          expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
          tokenHash: hashSessionToken(token),
          userId
        }
      });
    }
  });
  return token;
}

export function createMockSessionToken(user: SessionUser): string {
  const payload = {
    id: `mock-session-${user.id}`,
    user
  };
  return `${MOCK_SESSION_TOKEN_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getCurrentSession();
  return session?.user ?? null;
}

export async function getCurrentSession(): Promise<CurrentSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  if (isNoDatabaseMockMode()) {
    return readMockSessionToken(token);
  }

  const session = await withDatabaseContext({
    actor: systemDatabaseActor(),
    client: prisma,
    operation: (transaction) =>
      transaction.session.findUnique({
        include: { user: true },
        where: { tokenHash: hashSessionToken(token) }
      })
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return {
    id: session.id,
    user: {
      bookingStatus: session.user.bookingStatus,
      generation: session.user.generation,
      id: session.user.id,
      name: session.user.name,
      restrictionReason: session.user.restrictionReason,
      restrictedUntil: session.user.restrictedUntil ? session.user.restrictedUntil.toISOString() : null,
      role: session.user.role,
      shadowBanProfile: session.user.shadowBanProfile,
      studentNumber: session.user.studentNumber
    }
  };
}

export async function requireUser(): Promise<SessionUser> {
  const session = await getCurrentSession();
  if (!session) {
    throw new UnauthorizedSessionError();
  }
  return session.user;
}

export async function requireSession(): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) {
    throw new UnauthorizedSessionError();
  }
  return session;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") {
    throw new ForbiddenSessionError();
  }
  return user;
}

export async function requireAdminSession(): Promise<CurrentSession> {
  const session = await requireSession();
  if (session.user.role !== "ADMIN") {
    throw new ForbiddenSessionError();
  }
  return session;
}

export async function clearCurrentSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (isNoDatabaseMockMode()) {
    return;
  }
  if (token) {
    await withDatabaseContext({
      actor: systemDatabaseActor(),
      client: prisma,
      operation: async (transaction) => {
        await transaction.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
      }
    });
  }
}

export function setSessionCookie(response: Response, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${secure}`
  );
}

export function clearSessionCookie(response: Response): void {
  response.headers.append("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function hashSessionToken(token: string): string {
  return hashServerSecretValue(token, "session");
}

function readMockSessionToken(token: string): CurrentSession | null {
  if (!token.startsWith(MOCK_SESSION_TOKEN_PREFIX)) {
    return null;
  }

  try {
    const encodedPayload = token.slice(MOCK_SESSION_TOKEN_PREFIX.length);
    const parsedJson = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const parsedPayload = MockSessionPayloadSchema.safeParse(parsedJson);
    if (!parsedPayload.success) {
      return null;
    }
    return {
      id: parsedPayload.data.id,
      user: {
        ...parsedPayload.data.user,
        restrictionReason: parsedPayload.data.user.restrictionReason ?? null,
        restrictedUntil: parsedPayload.data.user.restrictedUntil ?? null,
        shadowBanProfile: parsedPayload.data.user.shadowBanProfile ?? DEFAULT_SHADOW_BAN_PROFILE
      }
    };
  } catch {
    return null;
  }
}

export class UnauthorizedSessionError extends Error {
  public constructor() {
    super("로그인이 필요합니다.");
    this.name = "UnauthorizedSessionError";
  }
}

export class ForbiddenSessionError extends Error {
  public constructor() {
    super("관리자 권한이 필요합니다.");
    this.name = "ForbiddenSessionError";
  }
}
