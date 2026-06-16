import { describe, expect, it } from "vitest";

import {
  buildNoShowBan,
  buildStudentCancellationRestriction,
  createMemoryReservationStore,
  reserveStudyPeriod,
  type ReservationStore,
  type TransactionalReservationStore
} from "./reservation-service";

describe("reservation service", () => {
  it("confirms only 10 concurrent reservations for one study period", async () => {
    const store = createMemoryReservationStore({
      capacity: 10,
      date: "2026-06-11",
      openTime: "08:00",
      closeTime: "23:00",
      userCount: 12
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) =>
        reserveStudyPeriod({
          date: "2026-06-11",
          now: new Date("2026-06-11T09:00:00+09:00"),
          reason: "자습",
          store,
          studyPeriod: "EIGHTH",
          userId: `user-${index + 1}`
        })
      )
    );

    expect(results.filter((result) => result.kind === "confirmed")).toHaveLength(10);
    expect(results.filter((result) => result.kind === "error" && result.reason === "full")).toHaveLength(2);
  });

  it("blocks pre-open, duplicate, and restricted-user reservations", async () => {
    const store = createMemoryReservationStore({
      capacity: 10,
      date: "2026-06-11",
      openTime: "10:00",
      closeTime: "23:00",
      restrictedUsers: ["user-2"],
      userCount: 2
    });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-11",
        now: new Date("2026-06-11T09:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "error", reason: "not_open_yet" });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-11",
        now: new Date("2026-06-11T11:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-2"
      })
    ).resolves.toMatchObject({ kind: "error", reason: "restricted" });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-11",
        now: new Date("2026-06-11T11:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "confirmed" });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-11",
        now: new Date("2026-06-11T11:01:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "error", reason: "duplicate" });
  });

  it("allows advance reservations after the daily configured open time", async () => {
    const store = createMemoryReservationStore({
      capacity: 10,
      date: "2026-06-12",
      openTime: "08:00",
      closeTime: "23:00",
      userCount: 1
    });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-12",
        now: new Date("2026-06-11T09:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "confirmed" });
  });

  it("stores the supplied reservation reason", async () => {
    const store = createMemoryReservationStore({
      capacity: 10,
      date: "2026-06-11",
      openTime: "08:00",
      closeTime: "23:00",
      userCount: 1
    });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-11",
        now: new Date("2026-06-11T09:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "EIGHTH",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "confirmed", reservation: { reason: "자습" } });
  });

  it("returns shadow_banned before creating a reservation for shadow-banned users", async () => {
    const innerStore = {
      countConfirmedReservations: async () => 0,
      createReservation: async () => {
        throw new Error("Shadow-banned users must not create reservations.");
      },
      findReservation: async () => null,
      getPeriodSetting: async () => ({
        capacity: 10,
        closeTime: "23:00",
        date: "2026-06-11",
        enabled: true,
        openTime: "08:00",
        studyPeriod: "EIGHTH" as const
      }),
      getUserBookingState: async () => ({
        bookingStatus: "SHADOW_BANNED" as const,
        restrictedUntil: null
      })
    } satisfies ReservationStore;
    const store = {
      transaction: async <T>(operation: (store: ReservationStore) => Promise<T>) => operation(innerStore)
    } satisfies TransactionalReservationStore;

    await expect(
      reserveStudyPeriod({
        date: "2026-06-11",
        now: new Date("2026-06-11T09:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "EIGHTH",
        userId: "user-shadow"
      })
    ).resolves.toEqual({ kind: "error", reason: "shadow_banned" });
  });

  it("blocks advance reservations after this week's Friday", async () => {
    const store = createMemoryReservationStore({
      capacity: 10,
      date: "2026-06-13",
      openTime: "08:00",
      closeTime: "23:00",
      userCount: 1
    });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-13",
        now: new Date("2026-06-11T09:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "error", reason: "advance_unavailable" });
  });

  it("blocks all advance reservations when today is Friday", async () => {
    const store = createMemoryReservationStore({
      capacity: 10,
      date: "2026-06-15",
      openTime: "08:00",
      closeTime: "23:00",
      userCount: 1
    });

    await expect(
      reserveStudyPeriod({
        date: "2026-06-15",
        now: new Date("2026-06-12T09:00:00+09:00"),
        reason: "자습",
        store,
        studyPeriod: "FIRST",
        userId: "user-1"
      })
    ).resolves.toMatchObject({ kind: "error", reason: "advance_unavailable" });
  });

  it("builds a three day restriction for student self cancellation", () => {
    const now = new Date("2026-06-12T13:30:00+09:00");

    const restriction = buildStudentCancellationRestriction(now);

    expect(restriction).toMatchObject({
      bookingStatus: "RESTRICTED",
      restrictionReason: "예약 취소"
    });
    expect(restriction.restrictedUntil?.toISOString()).toBe("2026-06-15T04:30:00.000Z");
  });

  it("builds a permanent ban for no-show processing", () => {
    const restriction = buildNoShowBan("정보실 예약 노쇼");

    expect(restriction).toEqual({
      bookingStatus: "BANNED",
      restrictedUntil: null,
      restrictionReason: "정보실 예약 노쇼"
    });
  });
});
