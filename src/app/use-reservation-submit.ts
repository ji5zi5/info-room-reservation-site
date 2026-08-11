"use client";

import { useCallback, useState } from "react";

import type { ReservationActionOutcome } from "@/components/reservation-action-dialog";
import { NETWORK_ERROR_MESSAGE, readApiErrorMessage } from "./client-api-response";
import { csrfFetch } from "./csrf-fetch";
import type { PeriodFetchResult } from "./reservation-home-period-contracts";
import {
  isReservationActionAuthorized,
  type ReservationActionAuthorization
} from "./reservation-home-period-contracts";

type ReservationStudyPeriod = "EIGHTH" | "FIRST";

type UseReservationSubmitInput = {
  readonly getReservationActionAuthorization: () => ReservationActionAuthorization;
  readonly profileOpen: boolean;
  readonly refreshPeriods: (date: string) => Promise<PeriodFetchResult>;
  readonly refreshProfile: () => Promise<void>;
  readonly setLoading: (loading: boolean) => void;
  readonly setToast: (message: string) => void;
  readonly targetDate: string;
};

type UseReservationSubmitResult = {
  readonly reservationSubmitting: boolean;
  readonly reserve: (
    studyPeriod: ReservationStudyPeriod,
    reason: string,
    authorization: ReservationActionAuthorization
  ) => Promise<ReservationActionOutcome>;
};

export function useReservationSubmit(input: UseReservationSubmitInput): UseReservationSubmitResult {
  const [reservationSubmitting, setReservationSubmitting] = useState(false);

  const reserve = useCallback(
    async (
      studyPeriod: ReservationStudyPeriod,
      reason: string,
      authorization: ReservationActionAuthorization
    ): Promise<ReservationActionOutcome> => {
      input.setLoading(true);
      setReservationSubmitting(true);
      try {
        const response = await csrfFetch(
          "/api/reservations",
          {
            body: JSON.stringify({ date: input.targetDate, reason, studyPeriod }),
            headers: { "content-type": "application/json" },
            method: "POST"
          },
          {
            isAuthorized: () =>
              isReservationActionAuthorized(authorization, input.getReservationActionAuthorization()),
            unauthorizedMessage: "최신 정보를 다시 불러온 뒤 확인해주세요."
          }
        );
        if (!response.ok) {
          const errorMessage = await readApiErrorMessage(response);
          await input.refreshPeriods(input.targetDate);
          input.setToast(errorMessage ?? "예약에 실패했습니다.");
          return { kind: "error" };
        }
        input.setToast("예약이 확정되었습니다.");
        await Promise.all([
          input.refreshPeriods(input.targetDate),
          ...(input.profileOpen ? [input.refreshProfile()] : [])
        ]);
        return { kind: "success" };
      } catch {
        input.setToast(NETWORK_ERROR_MESSAGE);
        return { kind: "error" };
      } finally {
        input.setLoading(false);
        setReservationSubmitting(false);
      }
    },
    [
      input.getReservationActionAuthorization,
      input.profileOpen,
      input.refreshPeriods,
      input.refreshProfile,
      input.setLoading,
      input.setToast,
      input.targetDate
    ]
  );

  return { reservationSubmitting, reserve };
}
