import { ForbiddenSessionError, UnauthorizedSessionError } from "./session";

export function toServerErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}

export function isUnauthorized(error: unknown): error is UnauthorizedSessionError {
  return error instanceof UnauthorizedSessionError;
}

export function isForbidden(error: unknown): error is ForbiddenSessionError {
  return error instanceof ForbiddenSessionError;
}
