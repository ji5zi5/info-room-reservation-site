import { messageForCsrfError, validateCsrfToken, type CsrfValidationResult } from "./csrf";
import { getCsrfTokenStore } from "./csrf-token-store";

export async function validateRequestCsrf(request: Request, sessionId: string): Promise<CsrfValidationResult> {
  return validateCsrfToken({
    now: new Date(),
    sessionId,
    store: getCsrfTokenStore(),
    token: request.headers.get("x-csrf-token")
  });
}

export { messageForCsrfError };
