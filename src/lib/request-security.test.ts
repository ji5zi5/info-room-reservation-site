import { describe, expect, it } from "vitest";

import { requireMutatingRequestSafety } from "./request-security";

function mutatingRequest(headers: Record<string, string> = {}, url = "http://localhost:3000/api/example"): Request {
  return new Request(url, {
    headers,
    method: "POST"
  });
}

describe("requireMutatingRequestSafety", () => {
  it("allows same-origin browser mutations", () => {
    const result = requireMutatingRequestSafety(
      mutatingRequest({
        origin: "http://localhost:3000",
        "sec-fetch-site": "same-origin"
      })
    );

    expect(result).toBeNull();
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
