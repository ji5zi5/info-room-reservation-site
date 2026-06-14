import { describe, expect, it } from "vitest";
import { z } from "zod";

import { readJsonRequest } from "./request-json";

const BodySchema = z.object({
  value: z.string()
});

describe("readJsonRequest", () => {
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
});
