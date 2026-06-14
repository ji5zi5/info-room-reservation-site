"use client";

import { z } from "zod";

type CsrfTokenResult =
  | {
      readonly kind: "ok";
      readonly token: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly status: number;
    };

const CsrfTokenPayloadSchema = z.object({
  csrfToken: z.string().min(1)
});

let csrfTokenPromise: Promise<CsrfTokenResult> | null = null;

export async function csrfFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const tokenResult = await getCsrfToken();
  if (tokenResult.kind === "error") {
    return jsonClientError(tokenResult.status, tokenResult.message);
  }
  const headers = new Headers(init.headers);
  headers.set("x-csrf-token", tokenResult.token);
  return fetch(input, { ...init, headers });
}

export function resetCsrfToken(): void {
  csrfTokenPromise = null;
}

async function getCsrfToken(): Promise<CsrfTokenResult> {
  csrfTokenPromise ??= fetch("/api/csrf")
    .then(async (response) => {
      if (!response.ok) {
        csrfTokenPromise = null;
        return { kind: "error", message: "보안 토큰을 가져오지 못했습니다.", status: response.status } as const;
      }
      const body = await response.text();
      if (!body.trim()) {
        csrfTokenPromise = null;
        return { kind: "error", message: "보안 토큰 응답이 비어 있습니다.", status: 500 } as const;
      }
      const parsed = parseCsrfBody(body);
      csrfTokenPromise = parsed.kind === "ok" ? csrfTokenPromise : null;
      return parsed;
    })
    .catch((error: unknown) => {
      csrfTokenPromise = null;
      if (error instanceof Error) {
        return { kind: "error", message: "보안 토큰 요청 중 오류가 발생했습니다.", status: 500 };
      }
      throw error;
    });
  return csrfTokenPromise;
}

function parseCsrfBody(body: string): CsrfTokenResult {
  try {
    const parsed = CsrfTokenPayloadSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      return { kind: "error", message: "보안 토큰 응답 형식이 올바르지 않습니다.", status: 500 };
    }
    return { kind: "ok", token: parsed.data.csrfToken };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: "error", message: "보안 토큰 응답 형식이 올바르지 않습니다.", status: 500 };
    }
    throw error;
  }
}

function jsonClientError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: "csrf_unavailable", message } }), {
    headers: { "content-type": "application/json" },
    status
  });
}
