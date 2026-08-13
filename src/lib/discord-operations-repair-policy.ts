export const DISCORD_REPAIR_ACTIONS = [
  "RETRY",
  "VERIFY_REMOTE",
  "SYNC",
  "REMOVE_CONTROLS",
  "ABANDON"
] as const;

export type DiscordRepairAction = (typeof DISCORD_REPAIR_ACTIONS)[number];

export type DiscordRemoteVerificationState =
  | "ERROR"
  | "MULTIPLE"
  | "NOT_STARTED"
  | "PARTIAL"
  | "UNIQUE"
  | "ZERO_COMPLETE"
  | "ZERO_PARTIAL";

export type DiscordRepairState =
  | {
      readonly ambiguity: "definite_non_accepting";
      readonly attemptsExhausted: boolean;
      readonly kind: "initial_send";
      readonly status: "FAILED" | "RETRY";
    }
  | {
      readonly kind: "initial_send";
      readonly status: "PENDING_REVIEW";
      readonly verification: DiscordRemoteVerificationState;
    }
  | {
      readonly kind: "source_sync";
      readonly sourceMessageId: string;
      readonly status: "REVISION_LAG";
    }
  | {
      readonly kind: "source_controls";
      readonly sourceMessageId: string;
      readonly status: "STALE" | "TERMINAL";
    }
  | {
      readonly kind: "unresolved";
      readonly nonceTombstoneRetained: true;
      readonly status: "EXHAUSTED" | "UNRESOLVED";
    }
  | { readonly kind: "healthy" };

export type DiscordRemoteVerificationDecision =
  | {
      readonly canDeleteTombstone: false;
      readonly canRetryPost: false;
      readonly kind: "bind_message";
      readonly messageId: string;
    }
  | {
      readonly canDeleteTombstone: false;
      readonly canRetryPost: false;
      readonly kind: "continue_review";
    };

export type DiscordOperationsControlState = {
  readonly enabled: boolean;
  readonly epoch: number;
  readonly pendingRemoteCleanup: boolean;
};

export type DiscordOperationStage = "CLAIM" | "INITIAL_POST" | "MUTATION" | "SOURCE_PATCH";

export type DiscordOperationFenceResult =
  | { readonly epoch: number; readonly kind: "allowed" }
  | { readonly kind: "disabled" }
  | { readonly kind: "draining" }
  | { readonly actualEpoch: number; readonly expectedEpoch: number; readonly kind: "stale_epoch" };

export function getDiscordRepairActions(state: DiscordRepairState): readonly DiscordRepairAction[] {
  switch (state.kind) {
    case "initial_send":
      switch (state.status) {
        case "FAILED":
        case "RETRY":
          return state.attemptsExhausted ? [] : ["RETRY"];
        case "PENDING_REVIEW":
          return ["VERIFY_REMOTE"];
        default:
          return assertNever(state);
      }
    case "source_sync":
      return state.sourceMessageId.length > 0 ? ["SYNC"] : [];
    case "source_controls":
      return state.sourceMessageId.length > 0 ? ["REMOVE_CONTROLS"] : [];
    case "unresolved":
      return state.nonceTombstoneRetained ? ["ABANDON"] : assertNever(state.nonceTombstoneRetained);
    case "healthy":
      return [];
    default:
      return assertNever(state);
  }
}

export function decideDiscordRemoteVerification(input: Readonly<{
  messageId: string | null;
  state: DiscordRemoteVerificationState;
}>): DiscordRemoteVerificationDecision {
  switch (input.state) {
    case "UNIQUE":
      return input.messageId === null
        ? { canDeleteTombstone: false, canRetryPost: false, kind: "continue_review" }
        : {
            canDeleteTombstone: false,
            canRetryPost: false,
            kind: "bind_message",
            messageId: input.messageId
          };
    case "ERROR":
    case "MULTIPLE":
    case "NOT_STARTED":
    case "PARTIAL":
    case "ZERO_COMPLETE":
    case "ZERO_PARTIAL":
      return { canDeleteTombstone: false, canRetryPost: false, kind: "continue_review" };
    default:
      return assertNever(input.state);
  }
}

export function evaluateDiscordOperationFence(input: Readonly<{
  control: DiscordOperationsControlState;
  expectedEpoch: number;
  stage: DiscordOperationStage;
}>): DiscordOperationFenceResult {
  void input.stage;
  if (!input.control.enabled) {
    return { kind: "disabled" };
  }
  if (input.control.pendingRemoteCleanup) {
    return { kind: "draining" };
  }
  if (input.expectedEpoch !== input.control.epoch) {
    return {
      actualEpoch: input.control.epoch,
      expectedEpoch: input.expectedEpoch,
      kind: "stale_epoch"
    };
  }
  return { epoch: input.control.epoch, kind: "allowed" };
}

function assertNever(value: never): never {
  throw new InvalidDiscordOperationsStateError(value);
}

class InvalidDiscordOperationsStateError extends Error {
  public constructor(readonly value: never) {
    super("Invalid Discord operations state");
    this.name = "InvalidDiscordOperationsStateError";
  }
}
