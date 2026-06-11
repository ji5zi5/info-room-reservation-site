import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "advance_unavailable"
  | "bad_request"
  | "closed"
  | "duplicate"
  | "disabled"
  | "forbidden"
  | "full"
  | "invalid_credentials"
  | "not_found"
  | "not_open_yet"
  | "restricted"
  | "server_error"
  | "unauthorized";

export function jsonError(status: number, code: ApiErrorCode, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}
