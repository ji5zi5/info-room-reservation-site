import type { NextResponse } from "next/server";
import type { z } from "zod";

import { jsonError } from "./http";

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
    readonly message: string;
    readonly schema: z.ZodType<T>;
  }
): Promise<JsonRequestResult<T>> {
  const body = await request.text();
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

function badJsonRequest(message: string): JsonRequestResult<never> {
  return {
    kind: "error",
    response: jsonError(400, "bad_request", message)
  };
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
