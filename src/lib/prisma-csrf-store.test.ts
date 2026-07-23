import { beforeEach, describe, expect, it, vi } from "vitest";

type CsrfTokenCreateInput = {
  readonly data: {
    readonly expiresAt: Date;
    readonly sessionId: string;
    readonly tokenHash: string;
  };
};

type CsrfTokenFindManyInput = {
  readonly orderBy: readonly [{ readonly createdAt: "desc" }, { readonly id: "desc" }];
  readonly select: { readonly id: true };
  readonly take: number;
  readonly where: { readonly sessionId: string };
};

type CsrfTokenDeleteManyInput = {
  readonly where: {
    readonly id: { readonly notIn: readonly string[] };
    readonly sessionId: string;
  };
};

type TransactionClient = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
  readonly csrfToken: {
    readonly create: (input: CsrfTokenCreateInput) => Promise<unknown>;
    readonly deleteMany: (input: CsrfTokenDeleteManyInput) => Promise<{ readonly count: number }>;
    readonly findMany: (input: CsrfTokenFindManyInput) => Promise<readonly { readonly id: string }[]>;
  };
};

type PrismaTransaction = <T>(
  operation: (transaction: TransactionClient) => Promise<T>,
  options?: unknown
) => Promise<T>;

const prismaMocks = vi.hoisted(() => {
  const transactionClient = {
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: readonly unknown[]) => undefined),
    csrfToken: {
      create: vi.fn(async (_input: CsrfTokenCreateInput) => undefined),
      deleteMany: vi.fn(async (_input: CsrfTokenDeleteManyInput) => ({ count: 2 })),
      findMany: vi.fn(async (_input: CsrfTokenFindManyInput) => [{ id: "keep-2" }, { id: "keep-1" }])
    }
  } satisfies TransactionClient;

  return {
    transaction: vi.fn<PrismaTransaction>(async (operation) => operation(transactionClient)),
    transactionClient
  };
});

vi.mock("./db", () => ({
  prisma: {
    $transaction: prismaMocks.transaction
  }
}));

import { prismaCsrfTokenStore } from "./prisma-csrf-store";

describe("Prisma CSRF token store", () => {
  beforeEach(() => {
    prismaMocks.transaction.mockClear();
    prismaMocks.transactionClient.$executeRaw.mockClear();
    prismaMocks.transactionClient.csrfToken.create.mockClear();
    prismaMocks.transactionClient.csrfToken.deleteMany.mockClear();
    prismaMocks.transactionClient.csrfToken.findMany.mockClear();
  });

  it("serializes minting and retains only the four newest tokens for a session", async () => {
    // Given
    const record = {
      expiresAt: new Date("2026-06-14T03:00:00.000Z"),
      sessionId: "session-a",
      tokenHash: "token-hash"
    };

    // When
    await prismaCsrfTokenStore.create(record);

    // Then
    expect(prismaMocks.transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "ReadCommitted" })
    );
    expect(prismaMocks.transactionClient.$executeRaw).toHaveBeenCalledTimes(3);
    expect(prismaMocks.transactionClient.csrfToken.create).toHaveBeenCalledWith({ data: record });
    expect(prismaMocks.transactionClient.csrfToken.findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
      take: 4,
      where: { sessionId: "session-a" }
    });
    expect(prismaMocks.transactionClient.csrfToken.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { notIn: ["keep-2", "keep-1"] },
        sessionId: "session-a"
      }
    });
  });
});
