import { z } from "zod";

import type { SessionUser } from "./session";

export const PublicSessionUserSchema = z
  .object({
    bookingStatus: z.string(),
    generation: z.number(),
    id: z.string(),
    name: z.string(),
    restrictionReason: z.string().nullable(),
    restrictedUntil: z.string().nullable(),
    role: z.string(),
    studentNumber: z.string()
  })
  .strict();

export type PublicSessionUser = z.infer<typeof PublicSessionUserSchema>;

export function maskStudentFacingSessionUser(user: SessionUser | null): PublicSessionUser | null {
  if (user === null) {
    return null;
  }

  const masksRestriction = user.role === "STUDENT" && user.bookingStatus === "SHADOW_BANNED";
  return PublicSessionUserSchema.parse({
    bookingStatus: masksRestriction ? "ACTIVE" : user.bookingStatus,
    generation: user.generation,
    id: user.id,
    name: user.name,
    restrictionReason: masksRestriction ? null : user.restrictionReason,
    restrictedUntil: masksRestriction ? null : user.restrictedUntil,
    role: user.role,
    studentNumber: user.studentNumber
  });
}
