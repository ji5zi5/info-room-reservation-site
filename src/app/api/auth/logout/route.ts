import { NextResponse } from "next/server";

import { clearCurrentSession, clearSessionCookie } from "@/lib/session";

export async function POST(): Promise<NextResponse> {
  await clearCurrentSession();
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
