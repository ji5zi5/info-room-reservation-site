import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminReadResult } from "./admin-api-client";
import type { AdminUser } from "./admin-types";

type AdminUserPage = {
  readonly cutoff: string;
  readonly currentTotalCount: number;
  readonly expiresAt: string;
  readonly items: readonly AdminUser[];
  readonly nextCursor: string | null;
};

type FetchAdminUsers = (input: { readonly query: string; readonly status: string }) => Promise<AdminReadResult<AdminUserPage>>;

const fetchMocks = vi.hoisted(() => ({
  fetchAdminUsers: vi.fn<FetchAdminUsers>()
}));

vi.mock("./admin-api-client", () => ({
  fetchAdminUsers: fetchMocks.fetchAdminUsers
}));

const activeUser = {
  bookingStatus: "ACTIVE",
  generation: 31,
  id: "active-user",
  name: "일반학생",
  restrictedUntil: null,
  restrictionReason: null,
  role: "STUDENT",
  shadowBanProfile: "NORMAL",
  studentNumber: "31001"
} satisfies AdminUser;

const shadowUser = {
  ...activeUser,
  bookingStatus: "SHADOW_BANNED",
  id: "shadow-user",
  name: "블랙학생",
  restrictionReason: "블랙리스트",
  shadowBanProfile: "HIGH",
  studentNumber: "31002"
} satisfies AdminUser;

describe("admin user fetching", () => {
  beforeEach(() => {
    fetchMocks.fetchAdminUsers.mockReset();
  });

  it("uses the selected status directly outside the blacklist section", async () => {
    const usersPage = page([activeUser], "active-next", 23);
    fetchMocks.fetchAdminUsers.mockResolvedValue({ data: usersPage, kind: "ok" });
    const { fetchAdminUsersForSection } = await import("./admin-user-fetching");

    const result = await fetchAdminUsersForSection({ activeSection: "students", query: "31001", status: "ACTIVE" });

    expect(result).toEqual({ data: usersPage, kind: "ok" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenCalledWith({ query: "31001", status: "ACTIVE" });
  });

  it("always loads current shadow-banned users on the blacklist section", async () => {
    const blacklistPage = page([shadowUser], "blacklist-next", 12);
    fetchMocks.fetchAdminUsers.mockResolvedValue({ data: blacklistPage, kind: "ok" });
    const { fetchAdminUsersForSection } = await import("./admin-user-fetching");

    const result = await fetchAdminUsersForSection({ activeSection: "blacklist", query: "", status: "ALL" });

    expect(result).toEqual({ data: blacklistPage, kind: "ok" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetchAdminUsers).toHaveBeenCalledWith({ query: "", status: "SHADOW_BANNED" });
  });

  it("merges current blacklist users with search results when adding a user", async () => {
    const blacklistPage = page([shadowUser], "blacklist-next", 12);
    const searchPage = page([activeUser, shadowUser], "search-next", 40);
    fetchMocks.fetchAdminUsers
      .mockResolvedValueOnce({ data: blacklistPage, kind: "ok" })
      .mockResolvedValueOnce({ data: searchPage, kind: "ok" });
    const { fetchAdminUsersForSection } = await import("./admin-user-fetching");

    const result = await fetchAdminUsersForSection({ activeSection: "blacklist", query: "310", status: "ALL" });

    expect(result).toEqual({
      data: { ...searchPage, items: [shadowUser, activeUser] },
      kind: "ok"
    });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenNthCalledWith(1, { query: "", status: "SHADOW_BANNED" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenNthCalledWith(2, { query: "310", status: "ALL" });
  });
});

function page(
  items: readonly AdminUser[],
  nextCursor: string | null,
  currentTotalCount: number
): AdminUserPage {
  return {
    cutoff: "2026-08-13T01:00:00.000Z",
    currentTotalCount,
    expiresAt: "2026-08-13T01:15:00.000Z",
    items,
    nextCursor
  };
}
