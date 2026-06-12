import { createHash, randomBytes } from "node:crypto";

import { cookies } from "next/headers";

import { prisma } from "./db";

export const SESSION_COOKIE_NAME = "info_room_session";

const SESSION_TTL_DAYS = 14;

export type SessionUser = {
  readonly bookingStatus: string;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly studentNumber: string;
};

export type CurrentSession = {
  readonly id: string;
  readonly user: SessionUser;
};

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
      tokenHash: hashSessionToken(token),
      userId
    }
  });
  return token;
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

  const session = await prisma.session.findUnique({
    include: { user: true },
    where: { tokenHash: hashSessionToken(token) }
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
      role: session.user.role,
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
  if (token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
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
  return createHash("sha256").update(token).digest("hex");
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
