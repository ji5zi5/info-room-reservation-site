import { waitForDiscordInteractionDeadline } from "./discord-interaction-deadline";

const ADMIN_RESPONSE_DEADLINE_MS = 1_500;

type SettledPreparation<T> =
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "prepared"; readonly prepared: T };

export type DiscordAdminPreparationDeadlineResult<T> = SettledPreparation<T> | {
  readonly kind: "timed_out";
  readonly pending: Promise<SettledPreparation<T>>;
};

export async function waitForDiscordAdminPreparation<T>(input: {
  readonly prepare: () => Promise<T>;
  readonly waitForDeadline?: (milliseconds: number, signal: AbortSignal) => Promise<boolean>;
}): Promise<DiscordAdminPreparationDeadlineResult<T>> {
  const abortController = new AbortController();
  const preparation = input.prepare().then(
    (prepared): SettledPreparation<T> => ({ kind: "prepared", prepared }),
    (error: unknown): SettledPreparation<T> => ({ error, kind: "failed" })
  );
  const waitForDeadline = input.waitForDeadline ?? waitForDiscordInteractionDeadline;
  const deadline = waitForDeadline(ADMIN_RESPONSE_DEADLINE_MS, abortController.signal).then(
    async (elapsed): Promise<SettledPreparation<T> | { readonly kind: "deadline" }> =>
      elapsed ? { kind: "deadline" } : preparation
  );
  const outcome = await Promise.race([preparation, deadline]);
  abortController.abort();
  return outcome.kind === "deadline"
    ? { kind: "timed_out", pending: preparation }
    : outcome;
}
