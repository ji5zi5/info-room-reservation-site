import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RateLimitResult } from "@/lib/rate-limit";
import type { RetentionPolicy, RetentionPreview } from "@/lib/retention-policy";
import type { CurrentSession, SessionUser } from "@/lib/session";

const mocks = vi.hoisted(() => ({
  applyApproved: vi.fn(),
  disable: vi.fn(),
  enforceAdminMutationRateLimit: vi.fn(),
  isNoDatabaseMockMode: vi.fn<() => boolean>(),
  preview: vi.fn(),
  requireAdmin: vi.fn(),
  requireAdminSession: vi.fn(),
  requireMutatingRequestSafety: vi.fn(),
  save: vi.fn(),
  validateRequestCsrf: vi.fn()
}));

vi.mock("@/lib/mock-dev-mode", () => ({
  isNoDatabaseMockMode: mocks.isNoDatabaseMockMode
}));

vi.mock("@/lib/prisma-retention-store", () => ({
  prismaRetentionStore: {
    applyApproved: mocks.applyApproved,
    disable: mocks.disable,
    preview: mocks.preview,
    save: mocks.save
  }
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
  requireAdmin: mocks.requireAdmin,
  requireAdminSession: mocks.requireAdminSession,
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {}
}));

import { DELETE, GET, PATCH, POST } from "./route";

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
const policy: RetentionPolicy = {
  adminDetailDays: 365,
  approvedAt: new Date("2026-07-01T00:00:00.000Z"),
  approvedBy: "privacy-officer",
  auditDetailDays: 365,
  departedUserIdentityDays: 30,
  enabled: false,
  id: "global",
  policyVersion: "school-v1",
  reservationReasonDays: 90,
  sanctionReasonDays: 365
};
const preview: RetentionPreview = {
  checksum: "a".repeat(64),
  counts: {
    adminActionDetails: 2,
    auditDetails: 1,
    departedUserIdentities: 0,
    reservationReasons: 3,
    sanctionReasons: 1
  },
  policyVersion: "school-v1"
};

describe("admin retention route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.isNoDatabaseMockMode.mockReturnValue(false);
    mocks.requireMutatingRequestSafety.mockReturnValue(null);
    mocks.requireAdmin.mockResolvedValue(admin);
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
    mocks.preview.mockResolvedValue({ policy, preview });
    mocks.save.mockResolvedValue(policy);
    mocks.disable.mockResolvedValue(policy);
    mocks.applyApproved.mockResolvedValue({ kind: "applied", preview });
  });

  it("returns a read-only dry-run preview for an administrator", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      policy: { enabled: false, policyVersion: "school-v1" },
      preview
    });
    expect(mocks.preview).toHaveBeenCalledWith({
      actor: { id: admin.id, role: "ADMIN" },
      now: expect.any(Date)
    });
  });

  it("saves a strict policy draft disabled after request safety, CSRF, and rate limiting", async () => {
    const response = await PATCH(request("PATCH", { policy: policyBody() }));

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      actor: { id: admin.id, role: "ADMIN" },
      ipHash: expect.any(String),
      policy: expect.objectContaining({
        approvedAt: new Date("2026-07-01T00:00:00.000Z"),
        policyVersion: "school-v1"
      })
    }));
  });

  it("rejects stale apply confirmation with the current preview", async () => {
    mocks.applyApproved.mockResolvedValue({ kind: "stale", preview });

    const response = await POST(request("POST", { checksum: "b".repeat(64) }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "retention_preview_stale" },
      preview
    });
  });

  it("applies the confirmed preview and can revoke scheduled cleanup", async () => {
    const applied = await POST(request("POST", { checksum: preview.checksum }));
    const disabled = await DELETE(request("DELETE"));

    expect(applied.status).toBe(200);
    expect(disabled.status).toBe(200);
    expect(mocks.applyApproved).toHaveBeenCalledWith(expect.objectContaining({
      expectedChecksum: preview.checksum
    }));
    expect(mocks.disable).toHaveBeenCalledOnce();
  });

  it("rejects unknown policy fields before storage", async () => {
    const response = await PATCH(
      request("PATCH", { policy: { ...policyBody(), deleteEverythingNow: true } })
    );

    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

function policyBody(): object {
  return {
    adminDetailDays: 365,
    approvedAt: "2026-07-01T00:00:00.000Z",
    approvedBy: "privacy-officer",
    auditDetailDays: 365,
    departedUserIdentityDays: 30,
    policyVersion: "school-v1",
    reservationReasonDays: 90,
    sanctionReasonDays: 365
  };
}

function request(method: "DELETE" | "PATCH" | "POST", body?: unknown): Request {
  const init: RequestInit = {
    headers: {
      "content-type": "application/json",
      origin: "https://example.test",
      "x-csrf-token": "csrf-token"
    },
    method
  };
  return new Request(
    "https://example.test/api/admin/retention",
    body === undefined ? init : { ...init, body: JSON.stringify(body) }
  );
}
