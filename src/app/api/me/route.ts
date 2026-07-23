import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/session";
import { maskStudentFacingSessionUser } from "@/lib/student-facing-session";

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  const response = NextResponse.json({ user: maskStudentFacingSessionUser(user) });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
