import { DEFAULT_RESTRICTION_DRAFT, type UserRestrictionDraft } from "./admin-console-state";

export function patchRestrictionDrafts(
  current: Readonly<Record<string, UserRestrictionDraft>>,
  userId: string,
  patch: Partial<UserRestrictionDraft>
): Readonly<Record<string, UserRestrictionDraft>> {
  return {
    ...current,
    [userId]: { ...(current[userId] ?? DEFAULT_RESTRICTION_DRAFT), ...patch }
  };
}
