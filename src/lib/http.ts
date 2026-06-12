import { NextResponse } from "next/server";

import type { MutatingRequestSafetyError } from "./request-security";
import type { RateLimitBlockedResult } from "./rate-limit";

export type ApiErrorCode =
  | "advance_unavailable"
  | "already_sent"
  | "admin_not_reservable"
  | "admin_target"
  | "bad_request"
  | "closed"
  | "csrf_expired"
  | "csrf_invalid"
  | "csrf_missing"
  | "discord_webhook_missing"
  | "duplicate"
  | "fetch_metadata_forbidden"
  | "disabled"
  | "forbidden"
  | "full"
  | "invalid_credentials"
  | "not_closed"
  | "not_found"
  | "not_open_yet"
  | "origin_forbidden"
  | "rate_limited"
  | "restricted"
  | "server_error"
  | "self_restriction"
  | "unauthorized";

export function jsonError(status: number, code: ApiErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function jsonMutatingRequestSafetyError(error: MutatingRequestSafetyError): NextResponse {
  return jsonError(403, error.code, error.message);
}

export function jsonRateLimitError(result: RateLimitBlockedResult): NextResponse {
  const response = jsonError(429, "rate_limited", "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.");
  response.headers.set("Retry-After", secondsUntil(result.resetAt).toString());
  return response;
}

function secondsUntil(resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
}
