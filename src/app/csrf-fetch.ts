"use client";

let csrfTokenPromise: Promise<string> | null = null;

export async function csrfFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-csrf-token", await getCsrfToken());
  return fetch(input, { ...init, headers });
}

export function resetCsrfToken(): void {
  csrfTokenPromise = null;
}

async function getCsrfToken(): Promise<string> {
  csrfTokenPromise ??= fetch("/api/csrf")
    .then(async (response) => {
      if (!response.ok) {
        throw new Error("CSRF token request failed");
      }
      const payload = (await response.json()) as { readonly csrfToken?: string };
      if (!payload.csrfToken) {
        throw new Error("CSRF token missing");
      }
      return payload.csrfToken;
    })
    .catch((error: unknown) => {
      csrfTokenPromise = null;
      throw error;
    });
  return csrfTokenPromise;
}
