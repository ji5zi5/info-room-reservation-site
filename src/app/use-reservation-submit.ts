"use client";

import { useCallback, useState } from "react";

import { readApiErrorMessage } from "./client-api-response";
import { csrfFetch } from "./csrf-fetch";

type ReservationStudyPeriod = "EIGHTH" | "FIRST";

type UseReservationSubmitInput = {
  readonly profileOpen: boolean;
  readonly refreshPeriods: (date: string) => Promise<unknown>;
  readonly refreshProfile: () => Promise<void>;
  readonly setLoading: (loading: boolean) => void;
  readonly setToast: (message: string) => void;
  readonly targetDate: string;
};

type UseReservationSubmitResult = {
  readonly reservationSubmitting: boolean;
  readonly reserve: (studyPeriod: ReservationStudyPeriod, reason: string) => Promise<void>;
};

export function useReservationSubmit(input: UseReservationSubmitInput): UseReservationSubmitResult {
  const [reservationSubmitting, setReservationSubmitting] = useState(false);

  const reserve = useCallback(
    async (studyPeriod: ReservationStudyPeriod, reason: string): Promise<void> => {
      input.setLoading(true);
      setReservationSubmitting(true);
      try {
        const response = await csrfFetch("/api/reservations", {
          body: JSON.stringify({ date: input.targetDate, reason, studyPeriod }),
          headers: { "content-type": "application/json" },
          method: "POST"
        });
        if (!response.ok) {
          const errorMessage = await readApiErrorMessage(response);
          await input.refreshPeriods(input.targetDate);
          input.setToast(errorMessage ?? "예약에 실패했습니다.");
          return;
        }
        input.setToast("예약이 확정되었습니다.");
        await Promise.all([
          input.refreshPeriods(input.targetDate),
          ...(input.profileOpen ? [input.refreshProfile()] : [])
        ]);
      } finally {
        input.setLoading(false);
        setReservationSubmitting(false);
      }
    },
    [input.profileOpen, input.refreshPeriods, input.refreshProfile, input.setLoading, input.setToast, input.targetDate]
  );

  return { reservationSubmitting, reserve };
}
