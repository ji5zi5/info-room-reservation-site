export type DiscordInteractionJobClaim = {
  readonly attempts: number;
  readonly claimId: string;
  readonly commandDigest: string;
  readonly discordActorId: string;
  readonly interactionId: string;
  readonly intent: string;
  readonly ipHash: string;
  readonly localActorId: string;
  readonly renderedEpoch: number;
  readonly reservationId: string;
  readonly sourceApplicationId: string | null;
  readonly sourceChannelId: string;
  readonly sourceGuildId: string;
  readonly sourceMessageId: string;
};

export type DiscordInteractionTerminalResult = {
  readonly [key: string]: DiscordInteractionTerminalValue;
};

type DiscordInteractionTerminalValue =
  | boolean
  | null
  | number
  | string
  | readonly DiscordInteractionTerminalValue[]
  | DiscordInteractionTerminalResult;

export type DiscordInteractionDispatchResult =
  | { readonly kind: "succeeded"; readonly terminalResult: DiscordInteractionTerminalResult }
  | { readonly kind: "stale"; readonly terminalResult: DiscordInteractionTerminalResult }
  | { readonly errorCode: string; readonly errorType: string; readonly kind: "retryable_failure" }
  | { readonly errorCode: string; readonly errorType: string; readonly kind: "terminal_failure" };

type DiscordInteractionFailureResult = {
  readonly errorCode: string;
  readonly errorType: string;
  readonly nextAttemptAt: Date | null;
  readonly status: "ABANDONED" | "RETRY";
};

export interface DiscordInteractionJobStore {
  claim(now: Date, interactionId?: string): Promise<readonly DiscordInteractionJobClaim[]>;
  completeFailure(input: {
    readonly claim: DiscordInteractionJobClaim;
    readonly result: DiscordInteractionFailureResult;
  }): Promise<void>;
  completeStale(input: {
    readonly claim: DiscordInteractionJobClaim;
    readonly errorCode?: string;
    readonly terminalResult: DiscordInteractionTerminalResult;
  }): Promise<void>;
  completeSuccess(input: {
    readonly claim: DiscordInteractionJobClaim;
    readonly terminalResult: DiscordInteractionTerminalResult;
  }): Promise<void>;
  isDispatchAllowed(claim: DiscordInteractionJobClaim): Promise<boolean>;
}

export type DiscordInteractionJobRunResult = {
  readonly abandoned: number;
  readonly claimed: number;
  readonly retried: number;
  readonly stale: number;
  readonly succeeded: number;
};

const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MINUTES = [1, 2, 5, 15, 30, 60] as const;

export async function runDiscordInteractionJobs(input: {
  readonly dispatch: (claim: DiscordInteractionJobClaim) => Promise<DiscordInteractionDispatchResult>;
  readonly interactionId?: string;
  readonly now: Date;
  readonly store: DiscordInteractionJobStore;
}): Promise<DiscordInteractionJobRunResult> {
  const claims = await input.store.claim(input.now, input.interactionId);
  const counts = { abandoned: 0, claimed: claims.length, retried: 0, stale: 0, succeeded: 0 };
  for (const claim of claims) {
    if (claim.sourceApplicationId === null) {
      await input.store.completeStale({
        claim,
        errorCode: "discord_source_application_missing",
        terminalResult: { code: "discord_source_application_missing" }
      });
      counts.stale += 1;
      continue;
    }
    if (!(await input.store.isDispatchAllowed(claim))) {
      await input.store.completeStale({ claim, terminalResult: { code: "discord_control_stale" } });
      counts.stale += 1;
      continue;
    }
    let outcome: DiscordInteractionDispatchResult;
    try {
      outcome = await input.dispatch(claim);
    } catch (error) {
      outcome = {
        errorCode: "unexpected_dispatch_error",
        errorType: redactedErrorType(error),
        kind: "retryable_failure"
      };
    }
    switch (outcome.kind) {
      case "succeeded":
        await input.store.completeSuccess({ claim, terminalResult: outcome.terminalResult });
        counts.succeeded += 1;
        break;
      case "stale":
        await input.store.completeStale({ claim, terminalResult: outcome.terminalResult });
        counts.stale += 1;
        break;
      case "retryable_failure": {
        const abandoned = claim.attempts >= MAX_ATTEMPTS;
        await input.store.completeFailure({
          claim,
          result: {
            errorCode: redactedIdentifier(outcome.errorCode),
            errorType: redactedIdentifier(outcome.errorType),
            nextAttemptAt: abandoned ? null : retryAt(input.now, claim.attempts),
            status: abandoned ? "ABANDONED" : "RETRY"
          }
        });
        counts[abandoned ? "abandoned" : "retried"] += 1;
        break;
      }
      case "terminal_failure":
        await input.store.completeFailure({
          claim,
          result: {
            errorCode: redactedIdentifier(outcome.errorCode),
            errorType: redactedIdentifier(outcome.errorType),
            nextAttemptAt: null,
            status: "ABANDONED"
          }
        });
        counts.abandoned += 1;
        break;
      default:
        assertNever(outcome);
    }
  }
  return counts;
}

function retryAt(now: Date, attempts: number): Date {
  const delay = RETRY_DELAYS_MINUTES[Math.min(attempts, RETRY_DELAYS_MINUTES.length) - 1] ?? 60;
  return new Date(now.getTime() + delay * 60_000);
}

function redactedErrorType(error: unknown): string {
  return error instanceof Error ? redactedIdentifier(error.name) : "UnknownError";
}

function redactedIdentifier(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/u.test(value) ? value : "redacted_error";
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled Discord interaction result: ${String(value)}`);
}
