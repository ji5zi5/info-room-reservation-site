import { DEFAULT_PERIOD_CAPACITY, type StudyPeriod } from "./study-periods";
import type {
  PeriodSetting,
  Reservation,
  ReservationStore,
  TransactionalReservationStore,
  UserBookingState
} from "./reservation-service";

type MemoryReservationStoreInput = {
  readonly capacity?: number;
  readonly closeTime: string;
  readonly date: string;
  readonly openTime: string;
  readonly restrictedUsers?: readonly string[];
  readonly shadowBannedUsers?: readonly string[];
  readonly userCount: number;
};

export function createMemoryReservationStore(input: MemoryReservationStoreInput): TransactionalReservationStore {
  const restrictedUsers = new Set(input.restrictedUsers ?? []);
  const shadowBannedUsers = new Set(input.shadowBannedUsers ?? []);
  const users = new Map<string, UserBookingState>();
  for (let index = 1; index <= input.userCount; index += 1) {
    const userId = `user-${index}`;
    users.set(userId, {
      bookingStatus: shadowBannedUsers.has(userId) ? "SHADOW_BANNED" : restrictedUsers.has(userId) ? "RESTRICTED" : "ACTIVE",
      restrictedUntil: null
    });
  }

  return new MemoryReservationStore({
    periodSettings: [
      {
        capacity: input.capacity ?? DEFAULT_PERIOD_CAPACITY,
        closeTime: input.closeTime,
        date: input.date,
        enabled: true,
        openTime: input.openTime,
        studyPeriod: "EIGHTH"
      },
      {
        capacity: input.capacity ?? DEFAULT_PERIOD_CAPACITY,
        closeTime: input.closeTime,
        date: input.date,
        enabled: true,
        openTime: input.openTime,
        studyPeriod: "FIRST"
      }
    ],
    users
  });
}

class MemoryReservationStore implements ReservationStore, TransactionalReservationStore {
  private locked = false;
  private readonly periodSettings: readonly PeriodSetting[];
  private readonly queue: Array<() => void> = [];
  private readonly reservations: Reservation[] = [];
  private readonly users: ReadonlyMap<string, UserBookingState>;

  public constructor(input: {
    readonly periodSettings: readonly PeriodSetting[];
    readonly users: ReadonlyMap<string, UserBookingState>;
  }) {
    this.periodSettings = input.periodSettings;
    this.users = input.users;
  }

  public async transaction<T>(
    _lockKeys: readonly string[],
    operation: (store: ReservationStore) => Promise<T>
  ): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation(this);
    } finally {
      release();
    }
  }

  public async countConfirmedReservations(date: string, studyPeriod: StudyPeriod): Promise<number> {
    return this.reservations.filter(
      (reservation) =>
        reservation.date === date && reservation.studyPeriod === studyPeriod && reservation.status === "CONFIRMED"
    ).length;
  }

  public async createReservation(input: {
    readonly date: string;
    readonly reason: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation> {
    const reservation = {
      date: input.date,
      id: `reservation-${this.reservations.length + 1}`,
      reason: input.reason,
      status: "CONFIRMED",
      studyPeriod: input.studyPeriod,
      userId: input.userId
    } satisfies Reservation;
    this.reservations.push(reservation);
    return reservation;
  }

  public async findReservation(input: {
    readonly date: string;
    readonly studyPeriod: StudyPeriod;
    readonly userId: string;
  }): Promise<Reservation | null> {
    return (
      this.reservations.find(
        (reservation) =>
          reservation.date === input.date &&
          reservation.studyPeriod === input.studyPeriod &&
          reservation.userId === input.userId &&
          reservation.status === "CONFIRMED"
      ) ?? null
    );
  }

  public async getPeriodSetting(date: string, studyPeriod: StudyPeriod): Promise<PeriodSetting | null> {
    return (
      this.periodSettings.find((setting) => setting.date === date && setting.studyPeriod === studyPeriod) ?? null
    );
  }

  public async getUserBookingState(userId: string): Promise<UserBookingState | null> {
    return this.users.get(userId) ?? null;
  }

  private async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => {
        this.release();
      };
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        resolve(() => {
          this.release();
        });
      });
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }
}
