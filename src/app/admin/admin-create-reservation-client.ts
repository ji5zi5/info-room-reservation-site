import { z } from "zod";

import { csrfFetch } from "../csrf-fetch";
import type { StudyPeriod } from "./admin-types";

export type AdminCreateReservationInput = {
  readonly date: string;
  readonly reason: string;
  readonly studentNumber: string;
  readonly studyPeriod: StudyPeriod;
};

export type AdminCreateReservationResult =
  | { readonly kind: "ok" }
  | { readonly kind: "error"; readonly message: string };

const ErrorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string()
    })
    .optional()
});

export async function createAdminReservation(
  input: AdminCreateReservationInput
): Promise<AdminCreateReservationResult> {
  const response = await csrfFetch("/api/admin/reservations", {
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (response.ok) {
    return { kind: "ok" };
  }
  return { kind: "error", message: await readErrorMessage(response) };
}

async function readErrorMessage(response: Response): Promise<string> {
  const body = await response.text();
  if (!body.trim()) {
    return "학생 예약 추가 실패";
  }
  const parsedJson = parseJsonBody(body);
  const parsedPayload = ErrorPayloadSchema.safeParse(parsedJson);
  return parsedPayload.success ? parsedPayload.data.error?.message ?? "학생 예약 추가 실패" : "학생 예약 추가 실패";
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}
