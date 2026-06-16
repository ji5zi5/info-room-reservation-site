import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminReadResult } from "./admin-api-client";
import type { AdminUser } from "./admin-types";

type FetchAdminUsers = (input: { readonly query: string; readonly status: string }) => Promise<AdminReadResult<readonly AdminUser[]>>;

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
  studentNumber: "31001"
} satisfies AdminUser;

const shadowUser = {
  ...activeUser,
  bookingStatus: "SHADOW_BANNED",
  id: "shadow-user",
  name: "블랙학생",
  restrictionReason: "블랙리스트",
  studentNumber: "31002"
} satisfies AdminUser;

describe("admin user fetching", () => {
  beforeEach(() => {
    fetchMocks.fetchAdminUsers.mockReset();
  });

  it("uses the selected status directly outside the blacklist section", async () => {
    fetchMocks.fetchAdminUsers.mockResolvedValue({ data: [activeUser], kind: "ok" });
    const { fetchAdminUsersForSection } = await import("./admin-user-fetching");

    const result = await fetchAdminUsersForSection({ activeSection: "students", query: "31001", status: "ACTIVE" });

    expect(result).toEqual({ data: [activeUser], kind: "ok" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenCalledWith({ query: "31001", status: "ACTIVE" });
  });

  it("always loads current shadow-banned users on the blacklist section", async () => {
    fetchMocks.fetchAdminUsers.mockResolvedValue({ data: [shadowUser], kind: "ok" });
    const { fetchAdminUsersForSection } = await import("./admin-user-fetching");

    const result = await fetchAdminUsersForSection({ activeSection: "blacklist", query: "", status: "ALL" });

    expect(result).toEqual({ data: [shadowUser], kind: "ok" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenCalledTimes(1);
    expect(fetchMocks.fetchAdminUsers).toHaveBeenCalledWith({ query: "", status: "SHADOW_BANNED" });
  });

  it("merges current blacklist users with search results when adding a user", async () => {
    fetchMocks.fetchAdminUsers
      .mockResolvedValueOnce({ data: [shadowUser], kind: "ok" })
      .mockResolvedValueOnce({ data: [activeUser, shadowUser], kind: "ok" });
    const { fetchAdminUsersForSection } = await import("./admin-user-fetching");

    const result = await fetchAdminUsersForSection({ activeSection: "blacklist", query: "310", status: "ALL" });

    expect(result).toEqual({ data: [shadowUser, activeUser], kind: "ok" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenNthCalledWith(1, { query: "", status: "SHADOW_BANNED" });
    expect(fetchMocks.fetchAdminUsers).toHaveBeenNthCalledWith(2, { query: "310", status: "ALL" });
  });
});
