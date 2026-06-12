import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "advance_unavailable"
  | "already_sent"
  | "bad_request"
  | "closed"
  | "discord_webhook_missing"
  | "duplicate"
  | "disabled"
  | "forbidden"
  | "full"
  | "invalid_credentials"
  | "not_closed"
  | "not_found"
  | "not_open_yet"
  | "restricted"
  | "server_error"
  | "unauthorized";

export function jsonError(status: number, code: ApiErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
