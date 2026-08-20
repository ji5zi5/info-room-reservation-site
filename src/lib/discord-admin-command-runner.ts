import {
  discordAdminFailureResult,
  type DiscordAdminCommandResult
} from "./discord-admin-command-results";

export type DiscordAdminCommandClaim = {
  readonly attempts: number;
  readonly claimId: string;
  readonly commandDigest: string;
  readonly discordActorId: string;
  readonly draftIntent: string;
  readonly executionInteractionId: string;
  readonly id: string;
  readonly ipHash: string;
  readonly localActorId: string;
  readonly reason: string | null;
  readonly sourceApplicationId: string;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceInteractionId: string;
};

export type DiscordAdminCommandDispatchResult =
  | { readonly kind: "succeeded"; readonly result: DiscordAdminCommandResult }
  | { readonly kind: "stale"; readonly result: DiscordAdminCommandResult }
  | { readonly errorCode: string; readonly errorType: string; readonly kind: "retryable_failure" }
  | { readonly errorCode: string; readonly errorType: string; readonly kind: "terminal_failure" };

export interface DiscordAdminCommandJobStore {
  claim(input: { readonly executionInteractionId?: string; readonly now: Date }): Promise<readonly DiscordAdminCommandClaim[]>;
  completeFailure(input: {
    readonly claim: DiscordAdminCommandClaim;
    readonly errorCode: string;
    readonly errorType: string;
    readonly nextAttemptAt: Date | null;
    readonly result: DiscordAdminCommandResult | null;
    readonly status: "ABANDONED" | "RETRY";
  }): Promise<void>;
  completeResult(input: {
    readonly claim: DiscordAdminCommandClaim;
    readonly result: DiscordAdminCommandResult;
    readonly status: "STALE" | "SUCCEEDED";
  }): Promise<void>;
}

export type DiscordAdminCommandRunSummary = {
  readonly abandoned: number;
  readonly claimed: number;
  readonly retried: number;
  readonly stale: number;
  readonly succeeded: number;
};

const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MINUTES = [1, 2, 5, 15, 30, 60] as const;

export async function runDiscordAdminCommandJobs(input: {
  readonly dispatch: (claim: DiscordAdminCommandClaim) => Promise<DiscordAdminCommandDispatchResult>;
  readonly executionInteractionId?: string;
  readonly now: Date;
  readonly store: DiscordAdminCommandJobStore;
}): Promise<DiscordAdminCommandRunSummary> {
  const claims = await input.store.claim({
    ...(input.executionInteractionId === undefined ? {} : { executionInteractionId: input.executionInteractionId }),
    now: input.now
  });
  const summary = { abandoned: 0, claimed: claims.length, retried: 0, stale: 0, succeeded: 0 };
  for (const claim of claims) {
    let outcome: DiscordAdminCommandDispatchResult;
    try {
      outcome = await input.dispatch(claim);
    } catch (error) {
      outcome = { errorCode: "unexpected_dispatch_error", errorType: errorType(error), kind: "retryable_failure" };
    }
    switch (outcome.kind) {
      case "succeeded":
        await input.store.completeResult({ claim, result: outcome.result, status: "SUCCEEDED" });
        summary.succeeded += 1;
        break;
      case "stale":
        await input.store.completeResult({ claim, result: outcome.result, status: "STALE" });
        summary.stale += 1;
        break;
      case "retryable_failure": {
        const abandoned = claim.attempts >= MAX_ATTEMPTS;
        await input.store.completeFailure({
          claim,
          errorCode: safeIdentifier(outcome.errorCode),
          errorType: safeIdentifier(outcome.errorType),
          nextAttemptAt: abandoned ? null : retryAt(input.now, claim.attempts),
          result: abandoned ? terminalFailureResult() : null,
          status: abandoned ? "ABANDONED" : "RETRY"
        });
        summary[abandoned ? "abandoned" : "retried"] += 1;
        break;
      }
      case "terminal_failure":
        await input.store.completeFailure({
          claim,
          errorCode: safeIdentifier(outcome.errorCode),
          errorType: safeIdentifier(outcome.errorType),
          nextAttemptAt: null,
          result: terminalFailureResult(),
          status: "ABANDONED"
        });
        summary.abandoned += 1;
        break;
      default:
        assertNever(outcome);
    }
  }
  return summary;
}

function terminalFailureResult(): DiscordAdminCommandResult {
  return discordAdminFailureResult({
    description: "요청을 완료하지 못했습니다. 현재 상태를 확인한 뒤 다시 실행해 주세요.",
    title: "처리 실패"
  });
}

function retryAt(now: Date, attempts: number): Date {
  const delay = RETRY_DELAYS_MINUTES[Math.min(attempts, RETRY_DELAYS_MINUTES.length) - 1] ?? 60;
  return new Date(now.getTime() + delay * 60_000);
}

function errorType(error: unknown): string {
  return error instanceof Error ? safeIdentifier(error.name) : "UnknownError";
}

function safeIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : "redacted_error";
}

function assertNever(value: never): never {
  throw new DiscordAdminCommandVariantError(JSON.stringify(value));
}

class DiscordAdminCommandVariantError extends Error {
  public override readonly name = "DiscordAdminCommandVariantError";
}
