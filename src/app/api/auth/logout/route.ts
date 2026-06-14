import { NextResponse } from "next/server";

import { jsonError, jsonMutatingRequestSafetyError } from "@/lib/http";
import { messageForCsrfError, validateRequestCsrf } from "@/lib/request-csrf";
import { requireMutatingRequestSafety } from "@/lib/request-security";
import { clearCurrentSession, clearSessionCookie, getCurrentSession } from "@/lib/session";

export async function POST(request: Request): Promise<NextResponse> {
  const requestSafetyError = requireMutatingRequestSafety(request);
  if (requestSafetyError) {
    return jsonMutatingRequestSafetyError(requestSafetyError);
  }

  const session = await getCurrentSession();
  if (session) {
    const csrfResult = await validateRequestCsrf(request, session.id);
    if (csrfResult.kind === "error") {
      return jsonError(403, csrfResult.reason, messageForCsrfError(csrfResult.reason));
    }
  }

  await clearCurrentSession();
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
