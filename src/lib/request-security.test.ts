import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerEnvError } from "./env";
import { requireMutatingRequestSafety } from "./request-security";

function mutatingRequest(headers: Record<string, string> = {}, url = "http://localhost:3000/api/example"): Request {
  return new Request(url, {
    headers,
    method: "POST"
  });
}

describe("requireMutatingRequestSafety", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows same-origin browser mutations", () => {
    const result = requireMutatingRequestSafety(
      mutatingRequest({
        origin: "http://localhost:3000",
        "sec-fetch-site": "same-origin"
      })
    );

    expect(result).toBeNull();
  });

  it("allows a browser Origin matching the validated canonical APP_ORIGIN when the internal request URL differs", () => {
    // Given
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3010");

    // When
    const result = requireMutatingRequestSafety(
      mutatingRequest(
        { origin: "http://127.0.0.1:3010", "sec-fetch-site": "same-origin" },
        "http://localhost:3010/api/example"
      )
    );

    // Then
    expect(result).toBeNull();
  });

  it("rejects a browser Origin that matches neither the internal request URL nor APP_ORIGIN", () => {
    // Given
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3010");

    // When
    const result = requireMutatingRequestSafety(
      mutatingRequest(
        { origin: "http://evil.example", "sec-fetch-site": "same-origin" },
        "http://localhost:3010/api/example"
      )
    );

    // Then
    expect(result).toEqual({
      code: "origin_forbidden",
      message: "요청 출처가 허용되지 않습니다."
    });
  });

  it("surfaces the existing APP_ORIGIN configuration error without echoing its value", () => {
    // Given
    vi.stubEnv("APP_ORIGIN", "not a valid origin");

    // When / Then
    expect(() =>
      requireMutatingRequestSafety(
        mutatingRequest({ origin: "http://127.0.0.1:3010" }, "http://localhost:3010/api/example")
      )
    ).toThrow(new ServerEnvError(["APP_ORIGIN"]));
  });

  it("blocks cross-origin browser mutations before route logic runs", () => {
    const result = requireMutatingRequestSafety(
      mutatingRequest({
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site"
      })
    );

    expect(result).toEqual({
      code: "origin_forbidden",
      message: "요청 출처가 허용되지 않습니다."
    });
  });

  it("blocks cross-site fetch metadata even when Origin is absent", () => {
    const result = requireMutatingRequestSafety(mutatingRequest({ "sec-fetch-site": "cross-site" }));

    expect(result).toEqual({
      code: "fetch_metadata_forbidden",
      message: "교차 사이트 요청은 허용되지 않습니다."
    });
  });

  it("keeps Fetch Metadata enforcement after a canonical APP_ORIGIN match", () => {
    // Given
    vi.stubEnv("APP_ORIGIN", "http://127.0.0.1:3010");

    // When
    const result = requireMutatingRequestSafety(
      mutatingRequest(
        { origin: "http://127.0.0.1:3010", "sec-fetch-site": "cross-site" },
        "http://localhost:3010/api/example"
      )
    );

    // Then
    expect(result).toEqual({
      code: "fetch_metadata_forbidden",
      message: "교차 사이트 요청은 허용되지 않습니다."
    });
  });

  it("allows manual or server-side requests without browser metadata", () => {
    const result = requireMutatingRequestSafety(mutatingRequest());

    expect(result).toBeNull();
  });

  it("blocks malformed Origin headers", () => {
    const result = requireMutatingRequestSafety(mutatingRequest({ origin: "not a url" }));

    expect(result).toEqual({
      code: "origin_forbidden",
      message: "요청 출처가 허용되지 않습니다."
    });
  });
});
