import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

import { prismaReservationStore } from "@/lib/prisma-reservation-store";
import { isReservableDate } from "@/lib/advance-reservation-policy";
import { ensurePeriodSettings } from "@/lib/period-settings";
import { reserveStudyPeriod } from "@/lib/reservation-service";
import { jsonError } from "@/lib/http";
import { requireUser, UnauthorizedSessionError } from "@/lib/session";

const ReservationRequestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  studyPeriod: z.union([z.literal("EIGHTH"), z.literal("FIRST")])
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const user = await requireUser();
    if (user.role === "ADMIN") {
      return jsonError(403, "admin_not_reservable", "관리자 계정은 예약할 수 없습니다.");
    }

    const parsed = ReservationRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return jsonError(400, "bad_request", "예약 요청 형식이 올바르지 않습니다.");
    }

    const now = new Date();
    if (!isReservableDate(parsed.data.date, now)) {
      return jsonError(409, "advance_unavailable", "사전예약 불가");
    }

    await ensurePeriodSettings(parsed.data.date);
    const result = await reserveStudyPeriod({
      date: parsed.data.date,
      now,
      store: prismaReservationStore,
      studyPeriod: parsed.data.studyPeriod,
      userId: user.id
    });

    if (result.kind === "confirmed") {
      return NextResponse.json({ reservation: result.reservation }, { status: 201 });
    }

    return jsonError(statusForReservationError(result.reason), result.reason, messageForReservationError(result.reason));
  } catch (error) {
    if (error instanceof UnauthorizedSessionError) {
      return jsonError(401, "unauthorized", error.message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return jsonError(409, "duplicate", "이미 예약한 시간대입니다.");
    }
    throw error;
  }
}

type ReservationErrorReason =
  | "advance_unavailable"
  | "admin_not_reservable"
  | "closed"
  | "disabled"
  | "duplicate"
  | "full"
  | "not_found"
  | "not_open_yet"
  | "restricted";

function statusForReservationError(reason: ReservationErrorReason): number {
  switch (reason) {
    case "advance_unavailable":
      return 409;
    case "admin_not_reservable":
    case "restricted":
      return 403;
    case "closed":
    case "disabled":
    case "duplicate":
    case "full":
    case "not_open_yet":
      return 409;
    case "not_found":
      return 404;
  }
}

function messageForReservationError(reason: ReservationErrorReason): string {
  switch (reason) {
    case "advance_unavailable":
      return "사전예약 불가";
    case "admin_not_reservable":
      return "관리자 계정은 예약할 수 없습니다.";
    case "closed":
      return "예약 시간이 마감되었습니다.";
    case "disabled":
      return "예약이 비활성화된 시간대입니다.";
    case "duplicate":
      return "이미 예약한 시간대입니다.";
    case "full":
      return "정원이 마감되었습니다.";
    case "not_found":
      return "예약 시간대를 찾을 수 없습니다.";
    case "not_open_yet":
      return "아직 예약이 열리지 않았습니다.";
    case "restricted":
      return "예약 이용이 제한되었습니다.";
  }
}
