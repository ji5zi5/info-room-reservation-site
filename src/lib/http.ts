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
  | "database_required"
  | "discord_webhook_missing"
  | "duplicate"
  | "fetch_metadata_forbidden"
  | "disabled"
  | "forbidden"
  | "full"
  | "invalid_credentials"
  | "needs_reconciliation"
  | "notification_state_conflict"
  | "not_closed"
  | "not_found"
  | "not_open_yet"
  | "origin_forbidden"
  | "rate_limited"
  | "retention_policy_unapproved"
  | "retention_preview_stale"
  | "retention_purge_disabled"
  | "reservation_unavailable"
  | "restricted"
  | "server_error"
  | "self_restriction"
  | "transaction_retry_exhausted"
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

export function jsonTransactionRetryExhaustedError(): NextResponse {
  const response = jsonError(
    503,
    "transaction_retry_exhausted",
    "동시 요청이 많습니다. 잠시 후 다시 시도해주세요."
  );
  response.headers.set("Retry-After", "1");
  return response;
}

function secondsUntil(resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
}
