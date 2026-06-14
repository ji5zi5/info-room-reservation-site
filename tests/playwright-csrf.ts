import type { APIResponse, Page } from "@playwright/test";

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];
type MutatingMethod = "DELETE" | "PATCH" | "POST";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

type CsrfRequestOptions = {
  readonly json?: JsonValue;
  readonly method: MutatingMethod;
};

export async function csrfRequest(page: Page, path: string, options: CsrfRequestOptions): Promise<APIResponse> {
  const csrfToken = await fetchCsrfToken(page);
  const headers = {
    "x-csrf-token": csrfToken
  };
  if (options.json === undefined) {
    return page.request.fetch(absoluteUrl(page, path), {
      headers,
      method: options.method
    });
  }

  return page.request.fetch(absoluteUrl(page, path), {
    data: options.json,
    headers,
    method: options.method
  });
}

export async function responseErrorCode(response: APIResponse): Promise<string | undefined> {
  const payload = await response.json();
  if (!isObject(payload)) {
    return undefined;
  }
  const error = Object.getOwnPropertyDescriptor(payload, "error")?.value;
  if (!isObject(error)) {
    return undefined;
  }
  const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return typeof code === "string" ? code : undefined;
}

async function fetchCsrfToken(page: Page): Promise<string> {
  const response = await page.request.get(absoluteUrl(page, "/api/csrf"));
  const payload = await response.json();
  if (!isObject(payload)) {
    throw new Error("csrf response should be an object");
  }
  const csrfToken = Object.getOwnPropertyDescriptor(payload, "csrfToken")?.value;
  if (typeof csrfToken !== "string" || csrfToken.length === 0) {
    throw new Error("csrf response should include csrfToken");
  }
  return csrfToken;
}

function absoluteUrl(page: Page, path: string): string {
  const currentUrl = page.url();
  const baseUrl = currentUrl === "about:blank" ? BASE_URL : currentUrl;
  return new URL(path, baseUrl).toString();
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
