import type { DiscordChannelHistoryPageResult } from "./discord-bot";

export const DISCORD_REMOTE_VERIFICATION_PAGE_SIZE = 100;

export type DiscordRemoteVerificationStatus =
  | "ERROR"
  | "MULTIPLE"
  | "PARTIAL"
  | "UNIQUE"
  | "ZERO_COMPLETE"
  | "ZERO_PARTIAL";

export type DiscordRemoteVerificationContinuation = {
  readonly attemptBoundary: string | null;
  readonly before: string | null;
  readonly complete: boolean;
  readonly lastErrorCode: string | null;
  readonly matchedMessageIds: readonly string[];
  readonly pagesScanned: number;
  readonly status: DiscordRemoteVerificationStatus;
  readonly version: 1;
};

export type DiscordRemoteVerificationRepository = {
  readonly loadTarget: (input: {
    readonly expectedControlEpoch: number;
    readonly expectedState: string;
    readonly reservationId: string;
  }) => Promise<
    | {
        readonly attemptBoundary: string;
        readonly channelId: string;
        readonly continuation: DiscordRemoteVerificationContinuation | null;
        readonly kind: "ready";
        readonly nonce: string;
      }
    | { readonly code: "disabled" | "draining" | "stale_epoch" | "stale_state"; readonly kind: "conflict" }
    | { readonly kind: "not_found" }
  >;
  readonly saveProgress: (input: {
    readonly boundMessageId: string | null;
    readonly continuation: DiscordRemoteVerificationContinuation;
    readonly expectedControlEpoch: number;
    readonly reservationId: string;
  }) => Promise<boolean>;
};

export type DiscordRemoteVerificationResult =
  | { readonly kind: "bound"; readonly messageId: string }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" }
  | { readonly kind: "unresolved"; readonly status: DiscordRemoteVerificationStatus };

export async function verifyRemoteDiscordReservationMessage(input: {
  readonly expectedControlEpoch: number;
  readonly expectedState: string;
  readonly pageSize?: number;
  readonly repository: DiscordRemoteVerificationRepository;
  readonly reservationId: string;
  readonly transport: {
    readonly listChannelMessagesPage: (input: {
      readonly before?: string;
      readonly channelId: string;
      readonly limit: number;
    }) => Promise<DiscordChannelHistoryPageResult>;
  };
}): Promise<DiscordRemoteVerificationResult> {
  const target = await input.repository.loadTarget({
    expectedControlEpoch: input.expectedControlEpoch,
    expectedState: input.expectedState,
    reservationId: input.reservationId
  });
  if (target.kind === "not_found") return target;
  if (target.kind === "conflict") return { kind: "conflict" };

  const pageSize = Math.max(1, Math.min(
    DISCORD_REMOTE_VERIFICATION_PAGE_SIZE,
    Math.trunc(input.pageSize ?? DISCORD_REMOTE_VERIFICATION_PAGE_SIZE)
  ));
  const previous = target.continuation ?? initialContinuation(target.attemptBoundary);
  const page = await input.transport.listChannelMessagesPage({
    ...(previous.before === null ? {} : { before: previous.before }),
    channelId: target.channelId,
    limit: pageSize
  });

  switch (page.kind) {
    case "found": {
      const matchedMessageIds = [
        ...new Set([
          ...previous.matchedMessageIds,
          ...page.messages.filter((message) => message.nonce === target.nonce).map((message) => message.id)
        ])
      ];
      const complete = page.messages.length < pageSize;
      const status = verificationStatus({ complete, matchCount: matchedMessageIds.length });
      const continuation: DiscordRemoteVerificationContinuation = {
        attemptBoundary: previous.attemptBoundary,
        before: page.messages.at(-1)?.id ?? previous.before,
        complete,
        lastErrorCode: null,
        matchedMessageIds,
        pagesScanned: previous.pagesScanned + 1,
        status,
        version: 1
      };
      const boundMessageId = status === "UNIQUE" ? matchedMessageIds[0] ?? null : null;
      const saved = await input.repository.saveProgress({
        boundMessageId,
        continuation,
        expectedControlEpoch: input.expectedControlEpoch,
        reservationId: input.reservationId
      });
      if (!saved) return { kind: "conflict" };
      return boundMessageId === null
        ? { kind: "unresolved", status }
        : { kind: "bound", messageId: boundMessageId };
    }
    case "retryable_failure":
    case "terminal_failure": {
      const continuation: DiscordRemoteVerificationContinuation = {
        ...previous,
        complete: false,
        lastErrorCode: page.code,
        status: "ERROR"
      };
      const saved = await input.repository.saveProgress({
        boundMessageId: null,
        continuation,
        expectedControlEpoch: input.expectedControlEpoch,
        reservationId: input.reservationId
      });
      return saved ? { kind: "unresolved", status: "ERROR" } : { kind: "conflict" };
    }
    default:
      return assertNever(page);
  }
}

function initialContinuation(attemptBoundary: string): DiscordRemoteVerificationContinuation {
  return {
    attemptBoundary,
    before: null,
    complete: false,
    lastErrorCode: null,
    matchedMessageIds: [],
    pagesScanned: 0,
    status: "ZERO_PARTIAL",
    version: 1
  };
}

function verificationStatus(input: {
  readonly complete: boolean;
  readonly matchCount: number;
}): DiscordRemoteVerificationStatus {
  if (!input.complete) return input.matchCount === 0 ? "ZERO_PARTIAL" : "PARTIAL";
  if (input.matchCount === 0) return "ZERO_COMPLETE";
  return input.matchCount === 1 ? "UNIQUE" : "MULTIPLE";
}

function assertNever(value: never): never {
  throw new DiscordRemoteVerificationVariantError(String(value));
}

class DiscordRemoteVerificationVariantError extends Error {
  public constructor(value: string) {
    super(`Unhandled Discord remote verification variant: ${value}`);
    this.name = "DiscordRemoteVerificationVariantError";
  }
}
