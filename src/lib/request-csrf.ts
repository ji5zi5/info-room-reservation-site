import { messageForCsrfError, validateCsrfToken, type CsrfValidationResult } from "./csrf";
import { prismaCsrfTokenStore } from "./prisma-csrf-store";

export async function validateRequestCsrf(request: Request, sessionId: string): Promise<CsrfValidationResult> {
  return validateCsrfToken({
    now: new Date(),
    sessionId,
    store: prismaCsrfTokenStore,
    token: request.headers.get("x-csrf-token")
  });
}

export { messageForCsrfError };
