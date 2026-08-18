import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDiscordLoopbackNodeOptions,
  acquireRolloutLock,
  parseOperationalRolloutArguments,
  parseRolloutAttempt,
  releaseRolloutLock,
  selectFreeSubstDrive
} from "../../scripts/operational-rollout-smoke";
import {
  activateApplicationContract,
  type ApplicationContractActivationClient
} from "./application-contract-activation";

const deploymentSha = "a".repeat(40);

describe("application contract activation", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("commits a source-bound receipt before activating it in a second transaction", async () => {
    // Given: an inactive expanded schema and a full deployment SHA.
    vi.stubEnv("DEPLOYMENT_SHA", deploymentSha);
    const fixture = activationClient([{ activatedAt: null }, [{ receiptId: "receipt-a" }], []]);

    // When: the first-cron activation service runs.
    const result = await activateApplicationContract({ client: fixture.client, source: "FIRST_CRON" });

    // Then: status, receipt creation, and activation are separate committed transactions.
    expect(result).toEqual({ deploymentSha, kind: "activated", source: "FIRST_CRON" });
    expect(fixture.transactions).toHaveLength(3);
    expect(fixture.transactions[1]?.queries.join("\n")).toContain("record_application_readiness");
    expect(fixture.transactions[2]?.queries.join("\n")).toContain("activate_application_contract");
    expect(fixture.transactions[2]?.values).toContain("receipt-a");
  });

  it("does not create or expose a receipt when the marker is already active", async () => {
    // Given: the exact v2 deployment is already active.
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", deploymentSha);
    const fixture = activationClient([{ activatedAt: new Date("2026-08-18T00:00:00Z") }]);

    // When: an admin retries activation.
    const result = await activateApplicationContract({ client: fixture.client, source: "ADMIN" });

    // Then: the service returns only public marker state and performs no receipt transaction.
    expect(result).toEqual({ deploymentSha, kind: "already_active", source: "ADMIN" });
    expect(fixture.transactions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("receipt");
  });

  it("creates a fresh receipt after a transaction-B rollback", async () => {
    // Given: the first activation consumes receipt-a only inside a transaction that rolls back.
    vi.stubEnv("GITHUB_SHA", deploymentSha);
    const fixture = activationClient([
      { activatedAt: null },
      [{ receiptId: "receipt-a" }],
      new Error("activation rollback"),
      { activatedAt: null },
      { activatedAt: null },
      [{ receiptId: "receipt-b" }],
      []
    ]);

    // When: the service is retried after the first transaction-B failure.
    await expect(activateApplicationContract({ client: fixture.client, source: "ADMIN" })).rejects.toThrow("activation rollback");
    await expect(activateApplicationContract({ client: fixture.client, source: "ADMIN" })).resolves.toMatchObject({ kind: "activated" });

    // Then: the retry activates only the newly committed receipt ID.
    const activationTransactions = fixture.transactions.filter((transaction) =>
      transaction.queries.some((query) => query.includes("activate_application_contract"))
    );
    expect(activationTransactions.map((transaction) => transaction.values.at(-2))).toEqual(["receipt-a", "receipt-b"]);
  });

  it("returns already-active when another source wins transaction B", async () => {
    // Given: this caller commits a receipt, but a concurrent activation wins the exclusive lock.
    vi.stubEnv("DEPLOYMENT_SHA", deploymentSha);
    const fixture = activationClient([
      { activatedAt: null },
      [{ receiptId: "receipt-a" }],
      new Error("schema contract is already activated"),
      { activatedAt: new Date("2026-08-18T00:00:00Z") }
    ]);

    // When/Then: the losing caller converges on the active marker instead of surfacing a false 5xx.
    await expect(activateApplicationContract({ client: fixture.client, source: "FIRST_CRON" })).resolves.toEqual({
      deploymentSha,
      kind: "already_active",
      source: "FIRST_CRON"
    });
    expect(fixture.transactions).toHaveLength(4);
  });

  it("returns already-active when another source activates before receipt creation", async () => {
    // Given: the initial marker is inactive, but another caller activates before transaction A records readiness.
    vi.stubEnv("DEPLOYMENT_SHA", deploymentSha);
    const fixture = activationClient([
      { activatedAt: null },
      new Error("schema must be expanded with workers disabled"),
      { activatedAt: new Date("2026-08-18T00:00:00Z") }
    ]);

    // When/Then: the transaction-A loser also converges on the active marker without a false 5xx.
    await expect(activateApplicationContract({ client: fixture.client, source: "ADMIN" })).resolves.toEqual({
      deploymentSha,
      kind: "already_active",
      source: "ADMIN"
    });
    expect(fixture.transactions).toHaveLength(3);
  });

  it("fails closed before database access when no full deployment SHA is available", async () => {
    // Given: no valid deployment identity in any supported environment variable.
    vi.stubEnv("DEPLOYMENT_SHA", "main");
    const fixture = activationClient([]);

    // When/Then: activation rejects before opening a transaction.
    await expect(activateApplicationContract({ client: fixture.client, source: "ADMIN" })).rejects.toMatchObject({
      code: "DEPLOYMENT_SHA_INVALID"
    });
    expect(fixture.transactions).toHaveLength(0);
  });
});

describe("immutable-base rollout input", () => {
  it("serializes concurrent rollout owners before shared artifact checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "todo20-rollout-lock-test-"));
    try {
      const first = await acquireRolloutLock(root);
      let secondAcquired = false;
      const secondPending = acquireRolloutLock(root).then((lock) => {
        secondAcquired = true;
        return lock;
      });

      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      expect(secondAcquired).toBe(false);
      await releaseRolloutLock(first);
      const second = await secondPending;
      expect(secondAcquired).toBe(true);
      await releaseRolloutLock(second);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("allows only credential-free loopback fake Discord targets", () => {
    expect(buildDiscordLoopbackNodeOptions("http://127.0.0.1:3219", "--trace-warnings"))
      .toMatch(/^--trace-warnings --import=data:text\/javascript;base64,/u);
    expect(() => buildDiscordLoopbackNodeOptions("https://discord.com")).toThrow("loopback");
    expect(() => buildDiscordLoopbackNodeOptions("http://user:secret@127.0.0.1:3219")).toThrow("loopback");
  });

  it("accepts rollout only with an absolute attempt directory", () => {
    // Given: the rollout profile and an absolute attempt evidence directory.
    const attemptDir = process.platform === "win32" ? "C:\\evidence\\attempt-a" : "/evidence/attempt-a";

    // When: the CLI boundary parses the arguments.
    const parsed = parseOperationalRolloutArguments(["rollout", "--attempt-dir", attemptDir]);

    // Then: the profile and exact directory are retained.
    expect(parsed).toEqual({ attemptDir, profile: "rollout" });
  });

  it("rejects rollout without attempt-dir and accepts no alternate base SHA", () => {
    // Given: a caller tries to provide a base identity outside immutable attempt.json.
    // When/Then: neither a missing directory nor an alternate SHA is accepted.
    expect(() => parseOperationalRolloutArguments(["rollout"])).toThrow();
    expect(() => parseOperationalRolloutArguments([
      "rollout", "--attempt-dir", "relative-attempt", "--base-sha", "a".repeat(40)
    ])).toThrow();
  });

  it("parses only a full attemptBaseSha from attempt.json", () => {
    // Given: immutable attempt metadata with an exact approved base.
    const attempt = { attemptBaseSha: "9".repeat(40), unrelated: "ignored" };

    // When/Then: the exact identity is parsed and malformed identities fail closed.
    expect(parseRolloutAttempt(attempt)).toEqual({ attemptBaseSha: "9".repeat(40) });
    expect(() => parseRolloutAttempt({ attemptBaseSha: "short" })).toThrow();
    expect(() => parseRolloutAttempt({ executionBaseSha: "9".repeat(40) })).toThrow();
  });

  it("selects the highest free temporary Windows drive and fails when none remain", () => {
    // Given: two occupied candidates at the top of the temporary range.
    // When/Then: the next free drive is deterministic and exhaustion fails closed.
    expect(selectFreeSubstDrive(["Z", "Y"])).toBe("X");
    expect(() => selectFreeSubstDrive(["Z", "Y", "X", "W", "V", "U", "T", "S", "R", "Q", "P"])).toThrow();
  });
});

type TransactionRecord = { readonly queries: string[]; readonly values: unknown[] };

function activationClient(outcomes: readonly unknown[]) {
  const transactions: TransactionRecord[] = [];
  let index = 0;
  const client: ApplicationContractActivationClient = {
    $transaction: async (operation) => {
      const record: { queries: string[]; values: unknown[] } = { queries: [], values: [] };
      transactions.push(record);
      const outcome = outcomes[index];
      index += 1;
      const transaction = {
        $executeRaw: async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
          record.queries.push(strings.join("?"));
          record.values.push(...values);
          return 1;
        },
        $queryRaw: async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
          record.queries.push(strings.join("?"));
          record.values.push(...values);
          if (outcome instanceof Error) throw outcome;
          return Array.isArray(outcome) ? outcome : [outcome];
        }
      };
      return operation(transaction);
    }
  };
  return { client, transactions };
}
