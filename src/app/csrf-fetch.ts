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

type CsrfRequestAuthorization = {
  readonly isAuthorized: () => boolean;
  readonly unauthorizedMessage: string;
};

const CsrfTokenPayloadSchema = z.object({
  csrfToken: z.string().min(1)
});

let csrfTokenPromise: Promise<CsrfTokenResult> | null = null;

const authorizationBlockedResponses = new WeakSet<Response>();

export async function csrfFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  authorization?: CsrfRequestAuthorization
): Promise<Response> {
  const tokenResult = await getCsrfToken();
  if (tokenResult.kind === "error") {
    return jsonClientError(tokenResult.status, tokenResult.message);
  }
  if (authorization && !authorization.isAuthorized()) {
    const response = jsonClientError(409, authorization.unauthorizedMessage, "stale_client_state");
    authorizationBlockedResponses.add(response);
    return response;
  }
  const headers = new Headers(init.headers);
  headers.set("x-csrf-token", tokenResult.token);
  return fetch(input, { ...init, headers });
}

export function isCsrfRequestAuthorizationBlocked(response: Response): boolean {
  return authorizationBlockedResponses.has(response);
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

function jsonClientError(
  status: number,
  message: string,
  code = "csrf_unavailable"
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    headers: { "content-type": "application/json" },
    status
  });
}
