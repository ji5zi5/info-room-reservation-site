import type { ReservationActionConfirmInput, ReservationPendingAction } from "@/components/reservation-action-dialog";
import type { PeriodSummary } from "@/components/reservation-period-card";
import type { getAdvanceReservationPolicy } from "@/lib/advance-reservation-policy";
import { addDays } from "@/lib/date";
import { buildReservationCalendarDays } from "@/lib/reservation-calendar";
import { readPeriodSummariesResult, readPeriodWeekPayload } from "./client-api-response";
import { toPeriodSummariesByDate } from "./reservation-period-week";

type AdvanceReservationPolicy = ReturnType<typeof getAdvanceReservationPolicy>;

export type PeriodFetchResult =
  | {
      readonly date: string;
      readonly kind: "ok";
      readonly periods: readonly PeriodSummary[];
    }
  | {
      readonly date: string;
      readonly kind: "not_modified";
    }
  | {
      readonly date: string;
      readonly kind: "error";
    };

export type PeriodWeekFetchResult =
  | {
      readonly etag: string | null;
      readonly kind: "ok";
      readonly periodsByDate: Readonly<Record<string, readonly PeriodSummary[]>>;
    }
  | { readonly kind: "not_modified" }
  | { readonly kind: "error" };

export type AuthenticationOwner = {
  readonly authenticationGeneration: number;
  readonly userId: string | null;
};

export type OwnedResourceRequest = AuthenticationOwner & {
  readonly requestGeneration: number;
};

export type ReservationActionAuthorization = AuthenticationOwner & {
  readonly periodFresh: boolean;
  readonly sessionFresh: boolean;
};

export type OwnedPendingReservationAction = {
  readonly action: ReservationPendingAction;
  readonly authorization: ReservationActionAuthorization;
};

export type PendingReservationActionDispatchResult =
  | { readonly kind: "blocked" }
  | { readonly kind: "ignored" }
  | { readonly kind: "submitted" };

export async function fetchPeriodSummariesForDate(date: string): Promise<PeriodFetchResult> {
  try {
    const response = await fetch(`/api/periods?date=${encodeURIComponent(date)}`);
    if (response.status === 304) {
      return { date, kind: "not_modified" };
    }
    const result = await readPeriodSummariesResult(response);
    if (result.kind === "error") {
      return { date, kind: "error" };
    }
    return { date, kind: "ok", periods: result.periods };
  } catch {
    return { date, kind: "error" };
  }
}

export async function fetchPeriodSummariesForWeek(
  weekStart: string,
  etag: string | null
): Promise<PeriodWeekFetchResult> {
  try {
    const url = `/api/periods?weekStart=${encodeURIComponent(weekStart)}`;
    const response = await (etag ? fetch(url, { headers: { "If-None-Match": etag } }) : fetch(url));
    if (response.status === 304) {
      return { kind: "not_modified" };
    }
    const payload = await readPeriodWeekPayload(response);
    if (!payload) {
      return { kind: "error" };
    }
    return {
      etag: response.headers.get("ETag"),
      kind: "ok",
      periodsByDate: toPeriodSummariesByDate(payload)
    };
  } catch {
    return { kind: "error" };
  }
}

export function isLatestOwnedResourceRequest(
  request: OwnedResourceRequest,
  currentOwner: AuthenticationOwner,
  latestRequestGeneration: number
): boolean {
  return (
    isLatestRequestGeneration(request.requestGeneration, latestRequestGeneration) &&
    request.authenticationGeneration === currentOwner.authenticationGeneration &&
    request.userId === currentOwner.userId
  );
}

export function isLatestRequestGeneration(requestGeneration: number, latestRequestGeneration: number): boolean {
  return requestGeneration === latestRequestGeneration;
}

export function dispatchPendingReservationAction(input: {
  readonly currentAuthorization: ReservationActionAuthorization;
  readonly onCancel: (reservationId: string) => void;
  readonly onReserve: (studyPeriod: "EIGHTH" | "FIRST", reason: string) => void;
  readonly pending: OwnedPendingReservationAction;
  readonly submittedInput: ReservationActionConfirmInput;
}): PendingReservationActionDispatchResult {
  if (!isReservationActionAuthorized(input.pending.authorization, input.currentAuthorization)) {
    return { kind: "blocked" };
  }
  switch (input.pending.action.kind) {
    case "cancel":
      if (input.submittedInput.kind !== "cancel") {
        return { kind: "ignored" };
      }
      input.onCancel(input.pending.action.reservationId);
      return { kind: "submitted" };
    case "reserve":
      if (input.submittedInput.kind !== "reserve") {
        return { kind: "ignored" };
      }
      input.onReserve(input.pending.action.studyPeriod, input.submittedInput.reason);
      return { kind: "submitted" };
  }
}

export function isReservationActionAuthorized(
  captured: ReservationActionAuthorization,
  current: ReservationActionAuthorization
): boolean {
  return (
    captured.authenticationGeneration === current.authenticationGeneration &&
    captured.userId !== null &&
    captured.userId === current.userId &&
    captured.sessionFresh &&
    captured.periodFresh &&
    current.sessionFresh &&
    current.periodFresh
  );
}

export function periodWeekStart(policy: AdvanceReservationPolicy | null): string | null {
  if (!policy) {
    return null;
  }
  return buildReservationCalendarDays(policy)[0]?.date ?? null;
}

export function isSchoolWeekDate(date: string, weekStart: string): boolean {
  return date >= weekStart && date <= addDays(weekStart, 4);
}
