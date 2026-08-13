import {
  fetchAdminUsers,
  type AdminReadOptions,
  type AdminReadPage,
  type AdminReadResult
} from "./admin-api-client";
import type { AdminSection } from "./admin-console-state";
import type { AdminUser, AdminUserStatusFilter } from "./admin-types";

type AdminUserFetchInput = {
  readonly activeSection: AdminSection;
  readonly query: string;
  readonly status: AdminUserStatusFilter;
};

export async function fetchAdminUsersForSection(
  input: AdminUserFetchInput,
  options?: AdminReadOptions
): Promise<AdminReadResult<AdminReadPage<AdminUser>>> {
  if (input.activeSection !== "blacklist") {
    const query = { query: input.query, status: input.status };
    return options ? fetchAdminUsers(query, options) : fetchAdminUsers(query);
  }

  const blacklistQuery = { query: "", status: "SHADOW_BANNED" } as const;
  const blacklist = await (options
    ? fetchAdminUsers(blacklistQuery, options)
    : fetchAdminUsers(blacklistQuery));
  if (blacklist.kind !== "ok" || input.query.trim() === "") {
    return blacklist;
  }

  const searchQuery = { query: input.query, status: "ALL" } as const;
  const searched = await (options
    ? fetchAdminUsers(searchQuery, options)
    : fetchAdminUsers(searchQuery));
  return searched.kind === "ok"
    ? {
        data: {
          ...searched.data,
          items: mergeAdminUsers(blacklist.data.items, searched.data.items)
        },
        kind: "ok"
      }
    : searched;
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
