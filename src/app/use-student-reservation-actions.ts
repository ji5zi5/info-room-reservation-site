"use client";

import { useCallback, useState, type RefObject } from "react";

import type {
  ReservationActionConfirmInput,
  ReservationActionOutcome,
  ReservationPendingAction
} from "@/components/reservation-action-dialog";
import type { PeriodSummary } from "@/components/reservation-period-card";
import { previewCancellationRestrictedUntil } from "@/lib/student-reservation-status";
import { NETWORK_ERROR_MESSAGE, readApiErrorMessage } from "./client-api-response";
import { csrfFetch } from "./csrf-fetch";
import { canReservePeriod } from "./reservation-home-reservation-rules";
import {
  dispatchPendingReservationAction,
  isReservationActionAuthorized,
  type OwnedPendingReservationAction,
  type ReservationActionAuthorization
} from "./reservation-home-period-contracts";
import type { ReservationStateRefreshResult } from "./reservation-home-period-refresh";
import { reservationRestrictionMessage } from "./reservation-home-helpers";
import type { ReservationSidebarUser } from "./reservation-sidebar";
import { useReservationSubmit } from "./use-reservation-submit";

type StudentReservationActionsInput = {
  readonly clearPendingActionRef: RefObject<() => void>;
  readonly getReservationActionAuthorization: () => ReservationActionAuthorization;
  readonly periods: readonly PeriodSummary[];
  readonly profileOpen: boolean;
  readonly refreshMe: () => Promise<void>;
  readonly refreshPeriods: (
    date: string,
    getFreshness: () => ReservationActionAuthorization
  ) => Promise<ReservationStateRefreshResult>;
  readonly refreshProfile: () => Promise<void>;
  readonly setLoading: (loading: boolean) => void;
  readonly setToast: (message: string) => void;
  readonly targetDate: string;
  readonly user: ReservationSidebarUser | null;
};

type StudentReservationActions = {
  readonly clearPendingAction: () => void;
  readonly confirmPendingAction: (input: ReservationActionConfirmInput) => Promise<ReservationActionOutcome>;
  readonly pendingAction: ReservationPendingAction | null;
  readonly requestCancel: (reservationId: string) => void;
  readonly requestReserve: (studyPeriod: "EIGHTH" | "FIRST") => Promise<void>;
  readonly reservationSubmitting: boolean;
};

export function useStudentReservationActions(input: StudentReservationActionsInput): StudentReservationActions {
  const [pendingAction, setPendingAction] = useState<OwnedPendingReservationAction | null>(null);
  const { reservationSubmitting, reserve } = useReservationSubmit({
    getReservationActionAuthorization: input.getReservationActionAuthorization,
    profileOpen: input.profileOpen,
    refreshPeriods: input.refreshPeriods,
    refreshProfile: input.refreshProfile,
    setLoading: input.setLoading,
    setToast: input.setToast,
    targetDate: input.targetDate
  });

  const cancelReservation = useCallback(async (
    reservationId: string,
    authorization: ReservationActionAuthorization
  ): Promise<ReservationActionOutcome> => {
    input.setLoading(true);
    try {
      const response = await csrfFetch(
        `/api/reservations/${reservationId}`,
        { method: "DELETE" },
        {
          isAuthorized: () =>
            isReservationActionAuthorized(authorization, input.getReservationActionAuthorization()),
          unauthorizedMessage: "최신 정보를 다시 불러온 뒤 확인해주세요."
        }
      );
      const errorMessage = await readApiErrorMessage(response);
      const [refreshResult] = await Promise.all([
        input.refreshPeriods(input.targetDate, input.getReservationActionAuthorization),
        ...(response.ok && input.profileOpen ? [input.refreshProfile()] : [])
      ]);
      if (!response.ok) {
        input.setToast(errorMessage ?? "예약 취소에 실패했습니다.");
        return { kind: "error" };
      }
      if (
        refreshResult.kind !== "settled" ||
        !isReservationActionAuthorized(authorization, input.getReservationActionAuthorization())
      ) {
        input.setToast("예약은 취소되었지만 최신 정보를 불러오지 못했습니다.");
        return { kind: "error" };
      }
      input.setToast("예약이 취소되었습니다. 3일간 예약이 제한됩니다.");
      return { kind: "success" };
    } catch {
      input.setToast(NETWORK_ERROR_MESSAGE);
      return { kind: "error" };
    } finally {
      input.setLoading(false);
    }
  }, [input]);

  const requestReserve = useCallback(async (studyPeriod: "EIGHTH" | "FIRST"): Promise<void> => {
    const authorizationBeforeRefresh = input.getReservationActionAuthorization();
    if (!isReservationActionAuthorized(authorizationBeforeRefresh, authorizationBeforeRefresh)) {
      input.setToast("최신 정보를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    const restrictionMessage = reservationRestrictionMessage(input.user);
    if (restrictionMessage) {
      input.setToast(restrictionMessage);
      return;
    }
    const refreshResult = await input.refreshPeriods(
      input.targetDate,
      input.getReservationActionAuthorization
    );
    if (refreshResult.kind === "stale") {
      input.setToast("최신 좌석 정보를 불러오지 못했습니다.");
      return;
    }
    const currentAuthorization = input.getReservationActionAuthorization();
    if (!isReservationActionAuthorized(authorizationBeforeRefresh, currentAuthorization)) {
      input.setToast("최신 정보를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    const refreshedPeriods = refreshResult.periods ?? input.periods;
    const period = refreshedPeriods.find((candidate) => candidate.studyPeriod === studyPeriod);
    if (!canReservePeriod(period)) {
      input.setToast("최신 좌석 수를 반영했습니다. 다시 확인하세요.");
      return;
    }
    input.setToast("");
    setPendingAction({
      action: { kind: "reserve", label: period?.label ?? "예약", studyPeriod },
      authorization: currentAuthorization
    });
  }, [input]);

  const requestCancel = useCallback((reservationId: string): void => {
    const authorization = input.getReservationActionAuthorization();
    if (!isReservationActionAuthorized(authorization, authorization)) {
      input.setToast("최신 정보를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    const period = input.periods.find((candidate) => candidate.myReservationId === reservationId);
    input.setToast("");
    setPendingAction({
      action: {
        kind: "cancel",
        label: period?.label ?? "예약",
        reservationId,
        restrictedUntilPreview: previewCancellationRestrictedUntil()
      },
      authorization
    });
  }, [input]);

  const confirmPendingAction = useCallback(async (
    submittedInput: ReservationActionConfirmInput
  ): Promise<ReservationActionOutcome> => {
    if (!pendingAction) {
      return { kind: "error" };
    }
    const confirmedAction = pendingAction;
    let actionOutcome: Promise<ReservationActionOutcome> = Promise.resolve({ kind: "error" });
    const result = dispatchPendingReservationAction({
      currentAuthorization: input.getReservationActionAuthorization(),
      onCancel: (reservationId) => {
        actionOutcome = cancelReservation(reservationId, confirmedAction.authorization);
      },
      onReserve: (studyPeriod, reason) =>
        { actionOutcome = reserve(studyPeriod, reason, confirmedAction.authorization); },
      pending: confirmedAction,
      submittedInput
    });
    if (result.kind === "blocked") {
      input.setToast("최신 정보를 다시 불러온 뒤 확인해주세요.");
      return { kind: "error" };
    }
    if (result.kind === "ignored") {
      return { kind: "error" };
    }
    const outcome = await actionOutcome;
    switch (outcome.kind) {
      case "error":
        return outcome;
      case "success":
        setPendingAction((current) => current === confirmedAction ? null : current);
        return outcome;
    }
  }, [cancelReservation, input, pendingAction, reserve]);

  const clearPendingAction = useCallback((): void => {
    setPendingAction(null);
  }, []);
  input.clearPendingActionRef.current = clearPendingAction;

  return {
    clearPendingAction,
    confirmPendingAction,
    pendingAction: pendingAction?.action ?? null,
    requestCancel,
    requestReserve,
    reservationSubmitting
  };
}
