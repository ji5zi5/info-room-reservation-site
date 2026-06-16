import { fetchAdminUsers, type AdminReadResult } from "./admin-api-client";
import type { AdminSection } from "./admin-console-state";
import type { AdminUser, AdminUserStatusFilter } from "./admin-types";

type AdminUserFetchInput = {
  readonly activeSection: AdminSection;
  readonly query: string;
  readonly status: AdminUserStatusFilter;
};

export async function fetchAdminUsersForSection(
  input: AdminUserFetchInput
): Promise<AdminReadResult<readonly AdminUser[]>> {
  if (input.activeSection !== "blacklist") {
    return fetchAdminUsers({ query: input.query, status: input.status });
  }

  const blacklist = await fetchAdminUsers({ query: "", status: "SHADOW_BANNED" });
  if (blacklist.kind !== "ok" || input.query.trim() === "") {
    return blacklist;
  }

  const searched = await fetchAdminUsers({ query: input.query, status: "ALL" });
  return searched.kind === "ok" ? { data: mergeAdminUsers(blacklist.data, searched.data), kind: "ok" } : searched;
}

function mergeAdminUsers(
  priorityUsers: readonly AdminUser[],
  otherUsers: readonly AdminUser[]
): readonly AdminUser[] {
  const usersById = new Map<string, AdminUser>();
  for (const user of [...priorityUsers, ...otherUsers]) {
    usersById.set(user.id, user);
  }
  return [...usersById.values()];
}
