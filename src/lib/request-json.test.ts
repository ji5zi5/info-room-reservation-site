import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { readJsonRequest } from "./request-json";

const BodySchema = z.object({
  value: z.string()
});

describe("readJsonRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a JSON 400 response when the request body is empty", async () => {
    const result = await readJsonRequest(new Request("http://localhost/api", { body: "", method: "POST" }), {
      message: "요청 형식이 올바르지 않습니다.",
      schema: BodySchema
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      throw new Error("Expected empty body to fail");
    }
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "요청 형식이 올바르지 않습니다." }
    });
  });

  it("returns a JSON 400 response when the request body is malformed", async () => {
    const result = await readJsonRequest(new Request("http://localhost/api", { body: "{", method: "POST" }), {
      message: "요청 형식이 올바르지 않습니다.",
      schema: BodySchema
    });

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      throw new Error("Expected malformed JSON to fail");
    }
    expect(result.response.status).toBe(400);
  });

  it("returns a JSON 413 response without parsing when the request body exceeds the configured limit", async () => {
    const parseJson = vi.spyOn(JSON, "parse");
    const oversizedMalformedBody = `{"value":"${"x".repeat(64)}`;

    const result = await readJsonRequest(
      new Request("http://localhost/api", { body: oversizedMalformedBody, method: "POST" }),
      {
        maxBytes: 32,
        message: "요청 형식이 올바르지 않습니다.",
        schema: BodySchema
      }
    );

    expect(result.kind).toBe("error");
    if (result.kind !== "error") {
      throw new Error("Expected oversized JSON to fail");
    }
    expect(result.response.status).toBe(413);
    expect(parseJson).not.toHaveBeenCalled();
    await expect(result.response.json()).resolves.toEqual({
      error: { code: "bad_request", message: "요청 본문이 너무 큽니다." }
    });
  });
});
