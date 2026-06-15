import type { AdminReadResult } from "./admin-api-client";

export function firstAdminReadError(results: readonly AdminReadResult<unknown>[]): string | null {
  for (const result of results) {
    if (result.kind === "unauthorized") {
      return "관리자 로그인이 필요합니다.";
    }
    if (result.kind === "error") {
      return result.message;
    }
  }
  return null;
}
