import { Prisma } from "@prisma/client";
import { vi } from "vitest";

import { CLOSED_LIST_NOTIFICATION_KIND, type ClosedPeriodNotificationStatus } from "./closed-period-notifications";
import type { StudyPeriod } from "./study-periods";

type StringFilter = string | { readonly gt?: string; readonly gte?: string; readonly in?: readonly string[]; readonly lte?: string };
type DateFilter = Date | { readonly gt?: Date; readonly lte?: Date };
type PeriodSettingWhere = {
  readonly date?: StringFilter;
  readonly enabled?: boolean;
  readonly OR?: readonly PeriodSettingWhere[];
  readonly studyPeriod?: StudyPeriod;
};
type NotificationDeliveryWhere = {
  readonly date?: StringFilter;
  readonly kind?: string;
  readonly OR?: readonly NotificationDeliveryWhere[];
  readonly status?: StringFilter;
  readonly studyPeriod?: StudyPeriod;
  readonly updatedAt?: DateFilter;
};
type NotificationDeliveryUpdateData = {
  readonly attempts?: { readonly increment: number };
  readonly lastError?: string | null;
  readonly messageIds?: string;
  readonly sentAt?: Date | null;
  readonly status?: ClosedPeriodNotificationStatus;
};

export type PeriodSettingRow = {
  readonly capacity: number;
  readonly closeTime: string;
  readonly date: string;
  readonly enabled: boolean;
  readonly openTime: string;
  readonly studyPeriod: StudyPeriod;
};
export type NotificationDeliveryRow = {
  attempts: number;
  readonly createdAt: Date;
  date: string;
  readonly id: string;
  kind: string;
  lastError: string | null;
  messageIds: string;
  sentAt: Date | null;
  status: ClosedPeriodNotificationStatus;
  studyPeriod: StudyPeriod;
  updatedAt: Date;
};

const prismaMocks = vi.hoisted(() => {
  const periodSettingsStore: PeriodSettingRow[] = [];
  const notificationDeliveriesStore: NotificationDeliveryRow[] = [];
  const reservationRows: { readonly reason: string | null; readonly user: { readonly name: string; readonly studentNumber: string } }[] = [];

  const periodSettingFindUnique = vi.fn(async (input: { readonly where: { readonly date_studyPeriod: { readonly date: string; readonly studyPeriod: StudyPeriod } } }) =>
    periodSettingsStore.find((setting) => setting.date === input.where.date_studyPeriod.date && setting.studyPeriod === input.where.date_studyPeriod.studyPeriod) ?? null
  );
  const periodSettingFindMany = vi.fn(async (input: { readonly where?: PeriodSettingWhere }) =>
    periodSettingsStore.filter((setting) => matchesPeriodSettingWhere(setting, input.where))
  );
  const reservationFindMany = vi.fn(async () => reservationRows);
  const notificationDeliveryFindMany = vi.fn(async (input: { readonly where?: NotificationDeliveryWhere }) =>
    notificationDeliveriesStore.filter((delivery) => matchesNotificationDeliveryWhere(delivery, input.where))
  );
  const notificationDeliveryFindUnique = vi.fn(async (input: { readonly where: { readonly date_studyPeriod_kind: { readonly date: string; readonly kind: string; readonly studyPeriod: StudyPeriod } } }) =>
    notificationDeliveriesStore.find((delivery) =>
      delivery.date === input.where.date_studyPeriod_kind.date &&
      delivery.kind === input.where.date_studyPeriod_kind.kind &&
      delivery.studyPeriod === input.where.date_studyPeriod_kind.studyPeriod
    ) ?? null
  );
  const notificationDeliveryCreate = vi.fn(async (input: { readonly data: Omit<NotificationDeliveryRow, "createdAt" | "id" | "updatedAt"> }) => {
    if (notificationDeliveriesStore.some((delivery) => delivery.date === input.data.date && delivery.kind === input.data.kind && delivery.studyPeriod === input.data.studyPeriod)) {
      throw prismaKnownError("P2002");
    }
    const row = {
      ...input.data,
      createdAt: new Date("2026-06-12T07:25:00.000Z"),
      id: `delivery-${notificationDeliveriesStore.length + 1}`,
      updatedAt: new Date("2026-06-12T07:25:00.000Z")
    };
    notificationDeliveriesStore.push(row);
    return row;
  });
  const notificationDeliveryUpdateMany = vi.fn(async (input: { readonly data?: NotificationDeliveryUpdateData; readonly where: NotificationDeliveryWhere }) => {
    const rows = notificationDeliveriesStore.filter((delivery) => matchesNotificationDeliveryWhere(delivery, input.where));
    for (const row of rows) {
      applyNotificationDeliveryUpdate(row, input.data);
    }
    return { count: rows.length };
  });

  return {
    notificationDeliveriesStore,
    notificationDeliveryCreate,
    notificationDeliveryFindMany,
    notificationDeliveryFindUnique,
    notificationDeliveryUpdateMany,
    periodSettingFindMany,
    periodSettingFindUnique,
    periodSettingsStore,
    reservationFindMany,
    reservationRows,
    reset: () => {
      periodSettingsStore.length = 0;
      reservationRows.length = 0;
      notificationDeliveriesStore.length = 0;
      periodSettingFindMany.mockClear();
      periodSettingFindUnique.mockClear();
      reservationFindMany.mockClear();
      notificationDeliveryFindMany.mockClear();
      notificationDeliveryFindUnique.mockClear();
      notificationDeliveryCreate.mockClear();
      notificationDeliveryUpdateMany.mockClear();
    }
  };
});

export { prismaMocks };

vi.mock("./db", () => ({
  prisma: {
    notificationDelivery: {
      create: prismaMocks.notificationDeliveryCreate,
      findMany: prismaMocks.notificationDeliveryFindMany,
      findUnique: prismaMocks.notificationDeliveryFindUnique,
      updateMany: prismaMocks.notificationDeliveryUpdateMany
    },
    periodSetting: {
      findMany: prismaMocks.periodSettingFindMany,
      findUnique: prismaMocks.periodSettingFindUnique
    },
    reservation: {
      findMany: prismaMocks.reservationFindMany
    }
  }
}));

export function periodSetting(input: {
  readonly capacity?: number;
  readonly closeTime?: string;
  readonly date: string;
  readonly enabled?: boolean;
  readonly openTime?: string;
  readonly studyPeriod: StudyPeriod;
}): PeriodSettingRow {
  return {
    capacity: input.capacity ?? 10,
    closeTime: input.closeTime ?? "16:20",
    date: input.date,
    enabled: input.enabled ?? true,
    openTime: input.openTime ?? "13:00",
    studyPeriod: input.studyPeriod
  };
}

export function delivery(input: {
  readonly date: string;
  readonly status: ClosedPeriodNotificationStatus;
  readonly studyPeriod: StudyPeriod;
  readonly updatedAt: Date;
}): NotificationDeliveryRow {
  return {
    attempts: 1,
    createdAt: input.updatedAt,
    date: input.date,
    id: `delivery-${input.date}-${input.studyPeriod}`,
    kind: CLOSED_LIST_NOTIFICATION_KIND,
    lastError: input.status === "FAILED" ? "previous failure" : null,
    messageIds: input.status === "SENT" ? "[\"sent-message\"]" : "[]",
    sentAt: input.status === "SENT" ? input.updatedAt : null,
    status: input.status,
    studyPeriod: input.studyPeriod,
    updatedAt: input.updatedAt
  };
}

export function prismaKnownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Prisma known error", { clientVersion: "test", code });
}

function matchesPeriodSettingWhere(row: PeriodSettingRow, where: PeriodSettingWhere | undefined): boolean {
  if (!where) {
    return true;
  }
  if (where.OR && !where.OR.some((branch) => matchesPeriodSettingWhere(row, branch))) {
    return false;
  }
  return matchesStringFilter(row.date, where.date) && matchesBooleanFilter(row.enabled, where.enabled) && matchesStudyPeriodFilter(row.studyPeriod, where.studyPeriod);
}

function matchesNotificationDeliveryWhere(row: NotificationDeliveryRow, where: NotificationDeliveryWhere | undefined): boolean {
  if (!where) {
    return true;
  }
  if (where.OR && !where.OR.some((branch) => matchesNotificationDeliveryWhere(row, branch))) {
    return false;
  }
  return (
    matchesStringFilter(row.date, where.date) &&
    matchesStringFilter(row.kind, where.kind) &&
    matchesStringFilter(row.status, where.status) &&
    matchesStudyPeriodFilter(row.studyPeriod, where.studyPeriod) &&
    matchesDateFilter(row.updatedAt, where.updatedAt)
  );
}

function matchesStringFilter(value: string, filter: StringFilter | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  if (typeof filter === "string") {
    return value === filter;
  }
  return !((filter.in && !filter.in.includes(value)) || (filter.lte && value > filter.lte) || (filter.gt && value <= filter.gt) || (filter.gte && value < filter.gte));
}

function matchesDateFilter(value: Date, filter: DateFilter | undefined): boolean {
  if (!filter) {
    return true;
  }
  if (filter instanceof Date) {
    return value.getTime() === filter.getTime();
  }
  return !((filter.lte && value.getTime() > filter.lte.getTime()) || (filter.gt && value.getTime() <= filter.gt.getTime()));
}

const matchesBooleanFilter = (value: boolean, filter: boolean | undefined): boolean => filter === undefined || value === filter;

const matchesStudyPeriodFilter = (value: StudyPeriod, filter: StudyPeriod | undefined): boolean => filter === undefined || value === filter;

function applyNotificationDeliveryUpdate(row: NotificationDeliveryRow, data: NotificationDeliveryUpdateData | undefined): void {
  if (!data) {
    return;
  }
  row.attempts += data.attempts?.increment ?? 0;
  if ("lastError" in data) {
    row.lastError = data.lastError ?? null;
  }
  if (data.messageIds !== undefined) {
    row.messageIds = data.messageIds;
  }
  if ("sentAt" in data) {
    row.sentAt = data.sentAt ?? null;
  }
  row.status = data.status ?? row.status;
  row.updatedAt = new Date("2026-06-12T07:25:01.000Z");
}
