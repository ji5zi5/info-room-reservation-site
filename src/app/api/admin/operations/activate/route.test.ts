import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateApplicationContract: vi.fn(),
  enforceAdminMutationRateLimit: vi.fn(),
  requireAdminSession: vi.fn(),
  requireMutatingRequestSafety: vi.fn(),
  validateRequestCsrf: vi.fn()
}));

vi.mock("@/lib/application-contract-activation", () => ({
  activateApplicationContract: mocks.activateApplicationContract
}));
vi.mock("@/lib/request-security", () => ({ requireMutatingRequestSafety: mocks.requireMutatingRequestSafety }));
vi.mock("@/lib/request-csrf", () => ({
  messageForCsrfError: () => "csrf",
  validateRequestCsrf: mocks.validateRequestCsrf
}));
vi.mock("@/lib/route-rate-limit", () => ({ enforceAdminMutationRateLimit: mocks.enforceAdminMutationRateLimit }));
vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  requireAdminSession: mocks.requireAdminSession
}));

import { POST } from "./route";

describe("admin application-contract activation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireMutatingRequestSafety.mockReturnValue(null);
    mocks.requireAdminSession.mockResolvedValue({ id: "session", user: { id: "admin", role: "ADMIN" } });
    mocks.validateRequestCsrf.mockResolvedValue({ kind: "ok" });
    mocks.enforceAdminMutationRateLimit.mockResolvedValue({ kind: "allowed" });
    mocks.activateApplicationContract.mockResolvedValue({ deploymentSha: "a".repeat(40), kind: "activated", source: "ADMIN" });
  });

  it("activates through the shared ADMIN service without returning a receipt", async () => {
    // Given: an authenticated, safe, CSRF-valid empty request.
    const request = activationRequest("{}");

    // When: the administrator activates the contract.
    const response = await POST(request);
    const body = await response.json();

    // Then: only the public activation result is returned.
    expect(response.status).toBe(200);
    expect(mocks.activateApplicationContract).toHaveBeenCalledWith({ source: "ADMIN" });
    expect(body).toEqual({ activation: expect.objectContaining({ kind: "activated", source: "ADMIN" }) });
    expect(JSON.stringify(body)).not.toContain("receipt");
  });

  it("rejects a client-supplied receipt before invoking activation", async () => {
    // Given: a browser attempts to inject a readiness receipt ID.
    const request = activationRequest('{"receiptId":"client-controlled"}');

    // When: the request crosses the route boundary.
    const response = await POST(request);

    // Then: strict parsing rejects it and the server service is untouched.
    expect(response.status).toBe(400);
    expect(mocks.activateApplicationContract).not.toHaveBeenCalled();
  });
});

function activationRequest(body: string): Request {
  return new Request("https://example.test/api/admin/operations/activate", {
    body,
    headers: {
      "content-type": "application/json",
      "origin": "https://example.test",
      "sec-fetch-site": "same-origin",
      "x-csrf-token": "csrf"
    },
    method: "POST"
  });
}
