import type { NextResponse } from "next/server";
import type { z } from "zod";

import { jsonError } from "./http";

const DEFAULT_JSON_REQUEST_MAX_BYTES = 16 * 1024;
const JSON_REQUEST_TOO_LARGE_MESSAGE = "요청 본문이 너무 큽니다.";

export type JsonRequestResult<T> =
  | {
      readonly data: T;
      readonly kind: "ok";
    }
  | {
      readonly kind: "error";
      readonly response: NextResponse;
    };

export async function readJsonRequest<T>(
  request: Request,
  input: {
    readonly maxBytes?: number;
    readonly message: string;
    readonly schema: z.ZodType<T>;
  }
): Promise<JsonRequestResult<T>> {
  const bodyResult = await readBoundedRequestText(request, input.maxBytes ?? DEFAULT_JSON_REQUEST_MAX_BYTES);
  if (bodyResult.kind === "too_large") {
    return requestTooLarge();
  }

  const body = bodyResult.body;
  if (!body.trim()) {
    return badJsonRequest(input.message);
  }

  const payload = parseJsonBody(body);
  if (payload.kind === "error") {
    return badJsonRequest(input.message);
  }

  const parsed = input.schema.safeParse(payload.data);
  if (!parsed.success) {
    return badJsonRequest(input.message);
  }

  return { data: parsed.data, kind: "ok" };
}

function requestTooLarge(): JsonRequestResult<never> {
  return {
    kind: "error",
    response: jsonError(413, "bad_request", JSON_REQUEST_TOO_LARGE_MESSAGE)
  };
}

function badJsonRequest(message: string): JsonRequestResult<never> {
  return {
    kind: "error",
    response: jsonError(400, "bad_request", message)
  };
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number
): Promise<{ readonly body: string; readonly kind: "ok" } | { readonly kind: "too_large" }> {
  if (!request.body) {
    return { body: "", kind: "ok" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return { body: body + decoder.decode(), kind: "ok" };
    }

    bytesRead += chunk.value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return { kind: "too_large" };
    }

    body += decoder.decode(chunk.value, { stream: true });
  }
}

function parseJsonBody(body: string): { readonly data: unknown; readonly kind: "ok" } | { readonly kind: "error" } {
  try {
    return { data: JSON.parse(body), kind: "ok" };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: "error" };
    }
    throw error;
  }
}
