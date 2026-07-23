import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { CurrentSession, SessionUser } from "@/lib/session";

type WriteOne = (input: unknown) => Promise<unknown>;
type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<number>;
  readonly adminAction: { readonly create: WriteOne };
  readonly auditLog: { readonly create: WriteOne };
  readonly session: {
    readonly deleteMany: (input: unknown) => Promise<{ readonly count: number }>;
  };
  readonly user: {
    readonly findUnique: (input: unknown) => Promise<UserRow | null>;
    readonly update: (input: unknown) => Promise<UserRow>;
  };
};
type UserRow = {
  readonly anonymizedAt: Date | null;
  readonly bookingStatus: string;
  readonly createdAt: Date;
  readonly departedAt: Date | null;
  readonly generation: number;
  readonly id: string;
  readonly name: string;
  readonly restrictionReason: string | null;
  readonly restrictedUntil: Date | null;
  readonly riroId: string | null;
  readonly role: string;
  readonly shadowBanProfile: string;
  readonly studentNumber: string;
  readonly updatedAt: Date;
};

const mocks = vi.hoisted(() => {
  const target = vi.fn<(input: unknown) => Promise<UserRow | null>>();
  const update = vi.fn<(input: unknown) => Promise<UserRow>>();
  const client = {
    $executeRaw: vi.fn(async () => 1),
    adminAction: { create: vi.fn<WriteOne>(async () => ({ id: "action-1" })) },
    auditLog: { create: vi.fn<WriteOne>(async () => ({ id: "audit-1" })) },
    session: {
      deleteMany: vi.fn(async () => ({ count: 2 }))
    },
    user: { findUnique: target, update }
  } satisfies TransactionClient;
  return {
    client,
    enforceAdminMutationRateLimit: vi.fn(),
    isNoDatabaseMockMode: vi.fn<() => boolean>(),
    requireAdminSession: vi.fn(),
    requireMutatingRequestSafety: vi.fn(),
    target,
    transaction: vi.fn(async (operation: (transaction: TransactionClient) => Promise<unknown>) =>
      operation(client)
    ),
    update,
    validateRequestCsrf: vi.fn()
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { $transaction: mocks.transaction }
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: mocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: (reason: string) => `csrf:${reason}`,
  validateRequestCsrf: mocks.validateRequestCsrf
}));

vi.mock("@/lib/request-security", () => ({
  requireMutatingRequestSafety: mocks.requireMutatingRequestSafety
}));

vi.mock("@/lib/route-rate-limit", () => ({
  enforceAdminMutationRateLimit: mocks.enforceAdminMutationRateLimit
}));

vi.mock("@/lib/session", () => ({
  ForbiddenSessionError: class ForbiddenSessionError extends Error {},
  requireAdminSession: mocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { DELETE, POST } from "./route";

const admin: SessionUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  studentNumber: "90000"
};

describe("admin user departure marker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireMutatingRequestSafety.mockReturnValue(null);
    mocks.requireAdminSession.mockResolvedValue({
      id: "admin-session",
      user: admin
    } satisfies CurrentSession);
    mocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    mocks.enforceAdminMutationRateLimit.mockResolvedValue({
      kind: "allowed",
      remaining: 9,
      resetAt: new Date("2026-07-24T12:01:00.000Z")
    } satisfies RateLimitResult);
    mocks.isNoDatabaseMockMode.mockReturnValue(false);
    mocks.target.mockResolvedValue(userRow());
    mocks.update.mockImplementation(async (input) => {
      const departedAt = JSON.stringify(input).includes('"departedAt":null')
        ? null
        : new Date("2026-07-24T12:00:00.000Z");
      return userRow({ departedAt });
    });
    mocks.transaction.mockImplementation(async (operation) => operation(mocks.client));
    mocks.client.adminAction.create.mockResolvedValue({ id: "action-1" });
    mocks.client.auditLog.create.mockResolvedValue({ id: "audit-1" });
    mocks.client.session.deleteMany.mockResolvedValue({ count: 2 });
  });

  it("marks a student as departed, revokes sessions, and records the reason", async () => {
    const response = await POST(
      request("POST", { reason: "전학" }),
      context("student-1")
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      data: { departedAt: expect.any(Date) },
      where: { id: "student-1" }
    });
    expect(mocks.client.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "student-1" }
    });
    expect(JSON.stringify(mocks.client.adminAction.create.mock.calls[0]?.[0])).toContain("전학");
  });

  it("can clear a mistaken marker before anonymization", async () => {
    mocks.target.mockResolvedValue(
      userRow({ departedAt: new Date("2026-07-20T00:00:00.000Z") })
    );

    const response = await DELETE(
      request("DELETE", { reason: "표시 정정" }),
      context("student-1")
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      data: { departedAt: null },
      where: { id: "student-1" }
    });
  });

  it("does not reverse an already anonymized account", async () => {
    mocks.target.mockResolvedValue(
      userRow({
        anonymizedAt: new Date("2026-07-24T00:00:00.000Z"),
        departedAt: new Date("2026-06-01T00:00:00.000Z")
      })
    );

    const response = await DELETE(
      request("DELETE", { reason: "복구 시도" }),
      context("student-1")
    );

    expect(response.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

function context(id: string): { readonly params: Promise<{ readonly id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function request(method: "DELETE" | "POST", body: unknown): Request {
  return new Request("https://example.test/api/admin/users/student-1/departure", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
      "x-csrf-token": "csrf-token"
    },
    method
  });
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  const timestamp = new Date("2026-07-01T00:00:00.000Z");
  return {
    anonymizedAt: null,
    bookingStatus: "ACTIVE",
    createdAt: timestamp,
    departedAt: null,
    generation: 31,
    id: "student-1",
    name: "학생",
    restrictionReason: null,
    restrictedUntil: null,
    riroId: "riro-student",
    role: "STUDENT",
    shadowBanProfile: "NORMAL",
    studentNumber: "31001",
    updatedAt: timestamp,
    ...overrides
  };
}
