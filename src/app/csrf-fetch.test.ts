import { afterEach, describe, expect, it, vi } from "vitest";

import { csrfFetch, isCsrfRequestAuthorizationBlocked, resetCsrfToken } from "./csrf-fetch";

afterEach(() => {
  resetCsrfToken();
  vi.unstubAllGlobals();
});

describe("csrfFetch mutation authorization boundary", () => {
  it("fetches a CSRF token for the first mutation and reuses it for the next one", async () => {
    const mutationTokens: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) === "/api/csrf") {
        return new Response(JSON.stringify({ csrfToken: "cached-token" }), { status: 200 });
      }
      mutationTokens.push(new Headers(init?.headers).get("x-csrf-token") ?? "");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstResponse = await csrfFetch("/api/reservations", { method: "POST" });
    const secondResponse = await csrfFetch("/api/reservations/reservation-a", { method: "DELETE" });

    expect(firstResponse.status).toBe(204);
    expect(secondResponse.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mutationTokens).toEqual(["cached-token", "cached-token"]);
  });

  it.each([
    ["reserve POST", "/api/reservations", "POST"],
    ["cancel DELETE", "/api/reservations/reservation-a", "DELETE"]
  ])("blocks %s when authorization changes while CSRF is held", async (_scenario, url, method) => {
    let authorizationCurrent = true;
    let releaseCsrf = (): void => undefined;
    const csrfGate = new Promise<void>((resolve) => {
      releaseCsrf = resolve;
    });
    const mutationRequests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input) === "/api/csrf") {
        await csrfGate;
        return new Response(JSON.stringify({ csrfToken: "held-token" }), { status: 200 });
      }
      mutationRequests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = csrfFetch(
      url,
      { method },
      {
        isAuthorized: () => authorizationCurrent,
        unauthorizedMessage: "최신 정보를 다시 불러온 뒤 확인해주세요."
      }
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/csrf"));

    authorizationCurrent = false;
    releaseCsrf();
    const response = await responsePromise;

    expect(mutationRequests, "mutation fetch must remain unreachable after held-CSRF authorization loss").toEqual([]);
    expect(response.status).toBe(409);
    expect(response.headers.has("x-client-authorization-blocked")).toBe(false);
    expect(isCsrfRequestAuthorizationBlocked(response)).toBe(true);
    expect(isCsrfRequestAuthorizationBlocked(response.clone())).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "stale_client_state",
        message: "최신 정보를 다시 불러온 뒤 확인해주세요."
      }
    });
  });

  it.each([
    ["conflict", 409],
    ["empty success", 204],
    ["successful response", 200]
  ])("does not trust a spoofed authorization header on a server %s", async (_scenario, status) => {
    const serverResponse = new Response(status === 204 ? null : "", {
      headers: { "x-client-authorization-blocked": "true" },
      status
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrfToken: "server-token" }), { status: 200 }))
      .mockResolvedValueOnce(serverResponse);
    vi.stubGlobal("fetch", fetchMock);

    const response = await csrfFetch("/api/reservations", { method: "POST" });

    expect(response).toBe(serverResponse);
    expect(isCsrfRequestAuthorizationBlocked(response)).toBe(false);
  });
});
