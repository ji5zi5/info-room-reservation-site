import { applyAdministratorUserSanction, removeAdministratorUserSanction } from "./admin-user-sanction-service";
import type { DiscordAuthorizedAdmin } from "./discord-admin-authorization";
import type { DiscordAdminIntent } from "./discord-admin-intents";
import { DEFAULT_SHADOW_BAN_PROFILE, type ShadowBanProfile } from "./shadow-ban-profile";

type UserMutationIntent = Extract<DiscordAdminIntent, {
  readonly kind: "student_ban" | "student_blacklist" | "student_release" | "student_restrict";
}>;

export type DiscordAdminUserMutationResult =
  | {
      readonly afterStatus: string;
      readonly beforeStatus: string;
      readonly cancelledFutureReservationCount: number;
      readonly kind: "updated";
      readonly studentName: string;
      readonly studentNumber: string;
    }
  | { readonly code: string; readonly kind: "noop" };

export async function executeDiscordAdminUserMutation(input: {
  readonly actor: DiscordAuthorizedAdmin;
  readonly intent: UserMutationIntent;
  readonly ipHash: string;
  readonly now: Date;
}): Promise<DiscordAdminUserMutationResult> {
  if (input.intent.kind === "student_release") {
    const result = await removeAdministratorUserSanction({
      actor: input.actor,
      ipHash: input.ipHash,
      reason: input.intent.reason,
      releaseType: input.intent.releaseType,
      studentNumber: input.intent.studentNumber
    });
    return formatResult(result, input.intent.studentNumber);
  }
  const sanction = sanctionInput(input.intent);
  const result = await applyAdministratorUserSanction({
    actor: input.actor,
    days: sanction.days,
    ipHash: input.ipHash,
    now: input.now,
    profile: sanction.profile,
    reason: input.intent.reason,
    status: sanction.status,
    studentNumber: input.intent.studentNumber
  });
  return formatResult(result, input.intent.studentNumber);
}

function sanctionInput(intent: Exclude<UserMutationIntent, { readonly kind: "student_release" }>): {
  readonly days: number | null;
  readonly profile: ShadowBanProfile;
  readonly status: "BANNED" | "RESTRICTED" | "SHADOW_BANNED";
} {
  switch (intent.kind) {
    case "student_restrict": return { days: intent.days, profile: DEFAULT_SHADOW_BAN_PROFILE, status: "RESTRICTED" as const };
    case "student_ban": return { days: null, profile: DEFAULT_SHADOW_BAN_PROFILE, status: "BANNED" as const };
    case "student_blacklist": return { days: null, profile: intent.profile, status: "SHADOW_BANNED" as const };
    default: return assertNever(intent);
  }
}

function formatResult(
  result: Awaited<ReturnType<typeof applyAdministratorUserSanction>>,
  studentNumber: string
): DiscordAdminUserMutationResult {
  return result.kind === "ok"
    ? {
        afterStatus: result.user.bookingStatus,
        beforeStatus: result.beforeStatus,
        cancelledFutureReservationCount: result.cancelledFutureReservationCount,
        kind: "updated",
        studentName: result.user.name,
        studentNumber
      }
    : { code: result.kind === "forbidden" ? result.reason : result.kind, kind: "noop" };
}

function assertNever(value: never): never {
  throw new DiscordAdminUserVariantError(JSON.stringify(value));
}

class DiscordAdminUserVariantError extends Error {
  public override readonly name = "DiscordAdminUserVariantError";
}
