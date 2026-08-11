import { Prisma } from "@prisma/client";
import { vi } from "vitest";

type MessageModel = {
  readonly create: ReturnType<typeof vi.fn>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly findUnique: ReturnType<typeof vi.fn>;
  readonly updateMany: ReturnType<typeof vi.fn<(
    input: Prisma.DiscordReservationMessageUpdateManyArgs
  ) => Promise<Prisma.BatchPayload>>>;
};

type ReceiptRow = { readonly terminalResult: Prisma.JsonValue };
type ReceiptModel = {
  readonly createMany: ReturnType<typeof vi.fn<(
    input: Prisma.DiscordInteractionReceiptCreateManyArgs
  ) => Promise<Prisma.BatchPayload>>>;
  readonly deleteMany: ReturnType<typeof vi.fn>;
  readonly findMany: ReturnType<typeof vi.fn>;
  readonly findUnique: ReturnType<typeof vi.fn<(
    input: Prisma.DiscordInteractionReceiptFindUniqueArgs
  ) => Promise<ReceiptRow | null>>>;
};

const repositoryMocks = vi.hoisted(() => {
  const messageModel = (): MessageModel => ({
    create: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn()
  });
  const receiptModel = (): ReceiptModel => ({
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn()
  });
  const transaction = {
    adminAction: { findFirst: vi.fn() },
    discordInteractionReceipt: receiptModel(),
    discordReservationMessage: messageModel()
  };
  return {
    transaction,
    withDatabaseContext: vi.fn(async (input: {
      readonly operation: (value: typeof transaction) => Promise<unknown>;
    }) => input.operation(transaction))
  };
});

export { repositoryMocks };

vi.mock("./db", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./db-context", () => ({
  systemDatabaseActor: () => ({ id: null, role: "SYSTEM" }),
  withDatabaseContext: repositoryMocks.withDatabaseContext
}));

export const repositoryNow = new Date("2026-08-11T00:00:00.000Z");

export function resetRepositoryMocks(): void {
  vi.clearAllMocks();
  repositoryMocks.transaction.discordReservationMessage.findMany.mockResolvedValue([]);
  repositoryMocks.transaction.discordReservationMessage.updateMany.mockResolvedValue({ count: 0 });
  repositoryMocks.transaction.discordReservationMessage.deleteMany.mockResolvedValue({ count: 0 });
  repositoryMocks.transaction.discordInteractionReceipt.findMany.mockResolvedValue([]);
  repositoryMocks.transaction.discordInteractionReceipt.deleteMany.mockResolvedValue({ count: 0 });
}
