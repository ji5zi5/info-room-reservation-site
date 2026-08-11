import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextResponse } from "next/server";
import type { User } from "@prisma/client";

import type { DatabaseActor } from "@/lib/db-context";
import type { SessionUser } from "@/lib/session";

type FindUnique = (input: unknown) => Promise<User | null>;
type Update = (input: unknown) => Promise<User>;
type ScopedTransaction = {
  readonly $executeRaw: (strings: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;
  readonly user: { readonly findUnique: FindUnique; readonly update: Update };
};
type WithDatabaseContext = <T>(input: {
  readonly actor: DatabaseActor;
  readonly client: unknown;
  readonly operation: (transaction: ScopedTransaction) => Promise<T>;
}) => Promise<T>;

const supportMocks = vi.hoisted(() => ({
  databaseActorFromSessionUser: vi.fn<(user: SessionUser) => DatabaseActor>(),
  rawUserFindUnique: vi.fn<FindUnique>(),
  rawUserUpdate: vi.fn<Update>(),
  scopedUserFindUnique: vi.fn<FindUnique>(),
  scopedUserUpdate: vi.fn<Update>(),
  withDatabaseContext: vi.fn<WithDatabaseContext>()
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: supportMocks.rawUserFindUnique,
      update: supportMocks.rawUserUpdate
    }
  }
}));
vi.mock("@/lib/db-context", () => ({
  databaseActorFromSessionUser: supportMocks.databaseActorFromSessionUser,
  withDatabaseContext: supportMocks.withDatabaseContext
}));

import { findRestrictableTarget } from "./restriction-route-support";

const authenticatedAdmin = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "admin-1",
  name: "관리자",
  restrictionReason: null,
  restrictedUntil: null,
  role: "ADMIN",
  shadowBanProfile: "NORMAL",
  studentNumber: "90000"
} satisfies SessionUser;

describe("findRestrictableTarget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    supportMocks.databaseActorFromSessionUser.mockReturnValue({ id: authenticatedAdmin.id, role: "ADMIN" });
    supportMocks.scopedUserFindUnique.mockResolvedValue(null);
    supportMocks.withDatabaseContext.mockImplementation(async (input) =>
      input.operation({
        $executeRaw: vi.fn(),
        user: {
          findUnique: supportMocks.scopedUserFindUnique,
          update: supportMocks.scopedUserUpdate
        }
      })
    );
  });

  it("uses the authenticated ADMIN actor for a scoped missing target read without mutating", async () => {
    const response = await findRestrictableTarget(authenticatedAdmin, "not-visible-to-admin");

    expect(supportMocks.databaseActorFromSessionUser).toHaveBeenCalledWith(authenticatedAdmin);
    expect(supportMocks.withDatabaseContext).toHaveBeenCalledWith({
      actor: { id: authenticatedAdmin.id, role: "ADMIN" },
      client: expect.any(Object),
      operation: expect.any(Function)
    });
    expect(supportMocks.scopedUserFindUnique).toHaveBeenCalledWith({ where: { id: "not-visible-to-admin" } });
    expect(supportMocks.rawUserFindUnique).not.toHaveBeenCalled();
    expect(supportMocks.rawUserUpdate).not.toHaveBeenCalled();
    expect(supportMocks.scopedUserUpdate).not.toHaveBeenCalled();
    if (!(response instanceof NextResponse)) {
      throw new Error("Expected the missing scoped target to return an error response.");
    }
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });
});
