// allow: SIZE_OK — one executable operational fixture keeps immutable rollout ownership, preload interception, and capacity evidence auditable together.
import { Buffer } from "node:buffer";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, lstat, mkdtemp, open, readFile, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

import {
  activateApplicationContract,
  type ApplicationContractActivationClient,
  type ApplicationContractActivationTransaction
} from "../src/lib/application-contract-activation";
import type { DiscordOperationsFenceRepository } from "../src/lib/discord-disable-pending";
import {
  runDiscordInteractionJobs,
  type DiscordInteractionJobClaim,
  type DiscordInteractionJobStore
} from "../src/lib/discord-interaction-job-runner";
import { ONLINE_INDEX_CHECKSUM, ONLINE_INDEX_MANIFEST } from "./apply-online-admin-search-indexes";

const ProfileSchema = z.enum(["capacity", "rollout"]);
const FullShaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const RolloutAttemptSchema = z.object({ attemptBaseSha: FullShaSchema }).strip();
const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, "attempt directory must be absolute");
const PROFILE_DEADLINE_MS = 12_500;
const TRANSPORT_CONCURRENCY = 10;
const MIGRATION_PAUSE_ADVISORY_KEY = 20_260_820;
const ROLLOUT_LOCK_WAIT_MS = 300_000;
const FenceRowsSchema = z.tuple([z.object({ epoch: z.number().int().nonnegative() }).strict()]);
const CountRowsSchema = z.tuple([z.object({ count: z.coerce.number().int().nonnegative() }).strict()]);
const SUBST_DRIVE_CANDIDATES = ["Z", "Y", "X", "W", "V", "U", "T", "S", "R", "Q", "P"] as const;

type TransportOutcome = "failed" | "rate_limited" | "sent" | "timeout";
type TransportTask = {
  readonly delayMs: number;
  readonly outcome: TransportOutcome;
};

type OperationalRolloutArguments =
  | { readonly profile: "capacity" }
  | { readonly attemptDir: string; readonly profile: "rollout" };

async function main(): Promise<void> {
  const input = parseOperationalRolloutArguments(process.argv.slice(2));
  switch (input.profile) {
    case "capacity":
      process.stdout.write(`${JSON.stringify(await capacityEvidence(), null, 2)}\n`);
      return;
    case "rollout":
      process.stdout.write(`${JSON.stringify(await immutableBaseRollout(input.attemptDir), null, 2)}\n`);
      return;
    default:
      return assertNever(input);
  }
}

export function parseOperationalRolloutArguments(args: readonly string[]): OperationalRolloutArguments {
  const profile = ProfileSchema.parse(args[0]);
  switch (profile) {
    case "capacity":
      if (args.length !== 1) throw new OperationalRolloutSmokeError("INVALID_ARGUMENTS", "Capacity profile accepts no additional arguments");
      return { profile };
    case "rollout": {
      if (args.length !== 3 || args[1] !== "--attempt-dir") {
        throw new OperationalRolloutSmokeError("INVALID_ARGUMENTS", "Rollout requires exactly --attempt-dir <absolute-path>");
      }
      return { attemptDir: AbsolutePathSchema.parse(args[2]), profile };
    }
    default:
      return assertNever(profile);
  }
}

export function parseRolloutAttempt(value: unknown): { readonly attemptBaseSha: string } {
  return RolloutAttemptSchema.parse(value);
}

export function selectFreeSubstDrive(occupied: readonly string[]): string {
  const occupiedSet = new Set(occupied.map((drive) => drive.toUpperCase()));
  const selected = SUBST_DRIVE_CANDIDATES.find((drive) => !occupiedSet.has(drive));
  if (selected === undefined) {
    throw new OperationalRolloutSmokeError("SUBST_DRIVE_UNAVAILABLE", "no free temporary drive letter is available");
  }
  return selected;
}

export async function capacityEvidence() {
  const schedulingStartedAt = performance.now();
  const scheduling = await runTransportFreeWorkerSchedule(300, 30);
  const schedulingElapsedMs = performance.now() - schedulingStartedAt;
  if (scheduling.invocations > 10 || scheduling.items !== 300 || schedulingElapsedMs > 10_000) {
    throw new OperationalRolloutSmokeError("SCHEDULING_CAPACITY_FAILED", "Transport-free scheduling exceeded its local bound");
  }

  const transportStartedAt = performance.now();
  const [bounded429, latency250ms, latency2s, mixedFailures, timeout10s] = await Promise.all([
    runTransportProfile([
      ...Array.from({ length: 10 }, () => ({ delayMs: 0, outcome: "rate_limited" as const })),
      ...Array.from({ length: 10 }, () => ({ delayMs: 0, outcome: "sent" as const }))
    ], 3_000),
    runTransportProfile(
      Array.from({ length: 20 }, () => ({ delayMs: 250, outcome: "sent" as const })),
      2_000
    ),
    runTransportProfile(
      Array.from({ length: 10 }, () => ({ delayMs: 2_000, outcome: "sent" as const })),
      3_000
    ),
    runTransportProfile([
      ...Array.from({ length: 8 }, () => ({ delayMs: 50, outcome: "sent" as const })),
      ...Array.from({ length: 4 }, () => ({ delayMs: 50, outcome: "failed" as const })),
      ...Array.from({ length: 4 }, () => ({ delayMs: 50, outcome: "rate_limited" as const }))
    ], 3_000),
    runTransportProfile([{ delayMs: 20_000, outcome: "timeout" }], 10_000)
  ]);
  const profiles = { bounded429, latency250ms, latency2s, mixedFailures, timeout10s };
  const transportElapsedMs = performance.now() - transportStartedAt;
  if (transportElapsedMs > PROFILE_DEADLINE_MS || profiles.timeout10s.timeout !== 1) {
    throw new OperationalRolloutSmokeError("TRANSPORT_PROFILE_FAILED", "Local transport profiles exceeded the hard deadline");
  }
  return {
    evidenceLabels: {
      scheduling: "LOCAL_TRANSPORT_FREE_SCHEDULING_NOT_PRODUCTION_CAPACITY",
      transport: "LOCAL_FAKE_TRANSPORT_PROFILES_NOT_PRODUCTION_CAPACITY"
    },
    ok: true,
    scheduling: { ...scheduling, elapsedMs: Math.ceil(schedulingElapsedMs), limit: "<=10 invocations/10 seconds" },
    transport: {
      concurrency: TRANSPORT_CONCURRENCY,
      elapsedMs: Math.ceil(transportElapsedMs),
      hardDeadlineMs: PROFILE_DEADLINE_MS,
      profiles,
      requeueVerified: true,
      worker: "runDiscordInteractionJobs"
    }
  } as const;
}

export function createPrismaDiscordOperationsFenceRuntime(
  directUrl: string,
  hooks: { readonly afterFenceBeforeTransportCount?: () => void } = {}
): {
  readonly close: () => Promise<void>;
  readonly repository: DiscordOperationsFenceRepository;
} {
  const client = new PrismaClient({ datasources: { db: { url: directUrl } } });
  return {
    close: () => client.$disconnect(),
    repository: {
      beginDisable: (now) => client.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.application_contract', 'discord-ops-v2', true)`;
        const control = FenceRowsSchema.parse(await transaction.$queryRaw`
          UPDATE "DiscordOperationsControl" SET "enabled"=false, "epoch"="epoch"+1,
            "disabledAt"=${now}, "updatedAt"=${now} WHERE "id"='discord-operations' RETURNING "epoch"
        `)[0];
        hooks.afterFenceBeforeTransportCount?.();
        const transport = CountRowsSchema.parse(await transaction.$queryRaw`
          SELECT count(*) AS count FROM "DiscordReservationMessage"
          WHERE "initialSendStatus" IN ('POSTING','SENDING') OR "syncStatus" IN ('PATCHING','SYNCING')
        `)[0];
        return { epoch: control.epoch, preFenceTransportCount: transport.count };
      }),
      countOldReservationMutations: async (epoch) => CountRowsSchema.parse(await client.$queryRaw`
        SELECT count(*) AS count FROM "DiscordInteractionJob" WHERE "status"='PROCESSING' AND "renderedEpoch" < ${epoch}
      `)[0].count,
      reenable: (input) => client.$transaction(async (transaction) => {
        await transaction.$executeRaw`SELECT set_config('app.application_contract', 'discord-ops-v2', true)`;
        const current = z.tuple([z.object({ pendingRemoteCleanup: z.boolean() }).strict()]).parse(
          await transaction.$queryRaw`SELECT "pendingRemoteCleanup" FROM "DiscordOperationsControl" WHERE "id"='discord-operations' FOR UPDATE`
        )[0];
        if (current.pendingRemoteCleanup && !input.acknowledgeResidualInertControls) return { kind: "ack_required" as const };
        const control = z.tuple([z.object({ enabled: z.boolean(), epoch: z.number(), pendingRemoteCleanup: z.boolean() }).strict()]).parse(
          await transaction.$queryRaw`UPDATE "DiscordOperationsControl" SET "enabled"=true, "epoch"="epoch"+1,
            "pendingRemoteCleanup"=false, "enabledAt"=${input.now}, "updatedAt"=${input.now}
            WHERE "id"='discord-operations' RETURNING "enabled", "epoch", "pendingRemoteCleanup"`
        )[0];
        return { control, kind: "enabled" as const };
      }),
      setPendingRemoteCleanup: async (pending, now) => {
        await client.$transaction(async (transaction) => {
          await transaction.$executeRaw`SELECT set_config('app.application_contract', 'discord-ops-v2', true)`;
          await transaction.$executeRaw`UPDATE "DiscordOperationsControl" SET "pendingRemoteCleanup"=${pending}, "updatedAt"=${now} WHERE "id"='discord-operations'`;
        });
      }
    }
  };
}

function createReadinessRaceClient(delegate: ApplicationContractActivationClient): {
  readonly client: ApplicationContractActivationClient;
  readonly isPaused: () => boolean;
  readonly release: () => void;
} {
  let paused = false;
  let released = false;
  let resolveRelease: (() => void) | undefined;
  const releaseSignal = new Promise<void>((resolveSignal) => { resolveRelease = resolveSignal; });
  const wrapTransaction = (
    transaction: ApplicationContractActivationTransaction
  ): ApplicationContractActivationTransaction => ({
    $executeRaw: (strings, ...values) => transaction.$executeRaw(strings, ...values),
    $queryRaw: async (strings, ...values) => {
      if (!paused && strings.join("?").includes("record_application_readiness")) {
        paused = true;
        await releaseSignal;
      }
      return transaction.$queryRaw(strings, ...values);
    }
  });
  return {
    client: {
      $transaction: (operation) => delegate.$transaction((transaction) => operation(wrapTransaction(transaction)))
    },
    isPaused: () => paused,
    release: () => {
      if (released) return;
      released = true;
      resolveRelease?.();
    }
  };
}

type ManagedChild = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>;
};

type RolloutLock = {
  readonly handle: FileHandle;
  readonly path: string;
};

type RolloutFakeDiscord = {
  readonly close: () => Promise<void>;
  readonly port: number;
  readonly requests: string[];
  readonly url: string;
};

type TrafficResult = {
  readonly cronStatus: number;
  readonly loginStatus: number;
  readonly reservationStatus: number;
  readonly studentNumber: string;
};

type RolloutScenarioResult = {
  readonly activation: {
    readonly deploymentSha: string;
    readonly interleaving: "TRANSACTION_A_READINESS_PAUSED";
    readonly outcomes: readonly string[];
    readonly source: string;
  };
  readonly base: { readonly buildId: string; readonly sha: string };
  readonly catalog: { readonly checksum: string; readonly indexes: readonly string[]; readonly state: string };
  readonly legacy: readonly Record<string, unknown>[];
  readonly localV2OwnerDml: { readonly missingContextRejected: boolean; readonly succeededWithContext: boolean; readonly wrongContextRejected: boolean };
  readonly oldArtifact: {
    readonly afterExpansion: TrafficResult;
    readonly beforeExpansion: TrafficResult;
    readonly duringIndexes: TrafficResult;
    readonly duringMigrations: TrafficResult;
    readonly postActivationMutationRejected: boolean;
  };
  readonly restrictedRole: { readonly control: string; readonly marker: string; readonly receipt: string };
};

const LoginResponseSchema = z.object({ user: z.object({ studentNumber: z.string() }) });
const CsrfResponseSchema = z.object({ csrfToken: z.string().min(1) });
const LegacyRowsSchema = z.array(z.object({
  initialSendStatus: z.string(),
  legacyControlState: z.string(),
  pendingReviewReason: z.string().nullable(),
  renderedSourceEpoch: z.number().int(),
  reservationId: z.string(),
  syncStatus: z.string()
}));

export async function immutableBaseRollout(attemptDir: string): Promise<object> {
  const resolvedAttemptDir = resolve(AbsolutePathSchema.parse(attemptDir));
  const baseWorktree = join(resolvedAttemptDir, "base-artifact-worktree");
  const repositoryRoot = process.cwd();
  assertExactChild(resolvedAttemptDir, baseWorktree, "base-artifact-worktree");
  const rolloutLock = await acquireRolloutLock(resolvedAttemptDir);
  let rolloutLockReleased = false;
  const releaseRolloutLockOnce = async (): Promise<void> => {
    if (rolloutLockReleased) return;
    rolloutLockReleased = true;
    await releaseRolloutLock(rolloutLock);
  };
  try {
    const registeredWorktrees = runCommandSync("git", ["worktree", "list", "--porcelain"], repositoryRoot).stdout;
    if (await pathExists(baseWorktree) || registeredWorktrees.includes(baseWorktree)) {
      await removeBaseWorktree(repositoryRoot, baseWorktree);
    }
    await assertPathMissing(baseWorktree);
  const attemptDocument = JSON.parse(await readFile(join(resolvedAttemptDir, "attempt.json"), "utf8"));
  const { attemptBaseSha } = parseRolloutAttempt(attemptDocument);
  const currentSha = FullShaSchema.parse(runCommandSync("git", ["rev-parse", "HEAD"], repositoryRoot).stdout.trim());
  const verifiedBaseSha = FullShaSchema.parse(
    runCommandSync("git", ["rev-parse", `${attemptBaseSha}^{commit}`], repositoryRoot).stdout.trim()
  );
  if (verifiedBaseSha !== attemptBaseSha) {
    throw new OperationalRolloutSmokeError("BASE_IDENTITY_MISMATCH", "attemptBaseSha did not resolve to the exact approved commit");
  }

  const databaseRoot = await mkdtemp(join(tmpdir(), "todo20-rollout-pg-"));
  const databaseDirectory = join(databaseRoot, "data");
  assertExactChild(dirname(databaseDirectory), databaseDirectory, "data");
  const databasePort = await allocatePort();
  const appPort = await allocatePort();
  const databaseName = `todo20_${randomBytes(8).toString("hex")}_test`;
  const databasePassword = randomBytes(24).toString("base64url");
  const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${databasePort}/${databaseName}?options=-c%20timezone%3DUTC`;
  const embedded = new EmbeddedPostgres({
    authMethod: "scram-sha-256",
    createPostgresUser: false,
    databaseDir: databaseDirectory,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onError: () => undefined,
    onLog: () => undefined,
    password: databasePassword,
    persistent: false,
    port: databasePort,
    postgresFlags: ["-h", "127.0.0.1"],
    user: "postgres"
  });
  let app: ManagedChild | undefined;
  let migration: ManagedChild | undefined;
  let indexes: ManagedChild | undefined;
  let observer: pg.Client | undefined;
  let locker: pg.Client | undefined;
  let indexBlocker: pg.Client | undefined;
  let fakeDiscord: RolloutFakeDiscord | undefined;
  let scenario: RolloutScenarioResult | undefined;
  let worktreeAdded = false;
  let databaseStarted = false;
  let substDrive: string | undefined;
  let substMapped = false;
  let executionWorktree = baseWorktree;
  try {
    await embedded.initialise();
    await embedded.start();
    databaseStarted = true;
    await embedded.createDatabase(databaseName);
    fakeDiscord = await startRolloutFakeDiscord();
    runCommandSync("git", ["worktree", "add", "--detach", baseWorktree, attemptBaseSha], repositoryRoot);
    worktreeAdded = true;
    if (process.platform === "win32") {
      substDrive = await findFreeSubstDrive();
      runCommandSync("subst", [`${substDrive}:`, resolvedAttemptDir], repositoryRoot);
      substMapped = true;
      executionWorktree = `${substDrive}:\\base-artifact-worktree`;
    }
    const checkedOutBase = FullShaSchema.parse(runCommandSync("git", ["rev-parse", "HEAD"], executionWorktree).stdout.trim());
    if (checkedOutBase !== attemptBaseSha) {
      throw new OperationalRolloutSmokeError("BASE_IDENTITY_MISMATCH", "detached worktree is not at attemptBaseSha");
    }

    const safeEnv = rolloutEnvironment(databaseUrl, appPort, attemptBaseSha, fakeDiscord.url);
    const npmCli = await resolveNpmCli();
    runNodeCommandSync(npmCli, ["ci", "--prefer-offline", "--no-audit", "--no-fund"], executionWorktree, safeEnv, 600_000);
    runNodeCommandSync(npmCli, ["run", "build"], executionWorktree, safeEnv, 600_000);
    const buildId = (await readFile(join(executionWorktree, ".next", "BUILD_ID"), "utf8")).trim();
    if (buildId.length === 0) throw new OperationalRolloutSmokeError("BASE_BUILD_FAILED", "base BUILD_ID is empty");

    const basePrismaCli = join(executionWorktree, "node_modules", "prisma", "build", "index.js");
    runNodeCommandSync(basePrismaCli, ["migrate", "deploy"], executionWorktree, safeEnv, 180_000);
    observer = await connect(databaseUrl);
    const reservationDate = await preparePreExpansionDatabase(observer);
    app = startManaged(process.execPath, [join(executionWorktree, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(appPort)], executionWorktree, safeEnv);
    await waitForApp(appPort, app);

    const beforeExpansion = await driveOldArtifactTraffic(appPort, reservationDate, "rollout-a", "EIGHTH");
    await installMigrationPause(observer);
    locker = await connect(databaseUrl);
    await locker.query("SELECT pg_advisory_lock($1)", [MIGRATION_PAUSE_ADVISORY_KEY]);
    const currentPrismaCli = join(repositoryRoot, "node_modules", "prisma", "build", "index.js");
    migration = startManaged(process.execPath, [currentPrismaCli, "migrate", "deploy"], repositoryRoot, safeEnv);
    await waitForBlockedMigration(observer, migration);
    const duringMigrations = await driveOldArtifactTraffic(appPort, reservationDate, "rollout-b", "FIRST");
    await locker.query("SELECT pg_advisory_unlock($1)", [MIGRATION_PAUSE_ADVISORY_KEY]);
    await locker.end();
    locker = undefined;
    requireSuccessfulChild(await migration.closed, "ordinary Prisma expansion");
    migration = undefined;
    await assertInactiveExpansion(observer);

    await populateOnlineIndexFixture(observer);
    indexBlocker = await connect(databaseUrl);
    await indexBlocker.query("BEGIN");
    await indexBlocker.query('UPDATE "User" SET "updatedAt"="updatedAt" WHERE "id"=\'legacy-user-send\'');
    const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
    indexes = startManaged(process.execPath, [tsxCli, "scripts/apply-online-admin-search-indexes.ts"], repositoryRoot, safeEnv);
    await waitForDatabaseStatement(observer, indexes, "CREATE INDEX CONCURRENTLY");
    const duringIndexes = await driveOldArtifactTraffic(appPort, reservationDate, "rollout-c", "EIGHTH");
    await indexBlocker.query("COMMIT");
    await indexBlocker.end();
    indexBlocker = undefined;
    requireSuccessfulChild(await indexes.closed, "online index runner");
    indexes = undefined;
    const catalog = await verifyOnlineIndexState(observer);
    const afterExpansion = await driveOldArtifactTraffic(appPort, reservationDate, "rollout-d", "FIRST");

    const legacy = await classifyLegacyControls(observer);
    const restrictedRole = await verifyRestrictedRoleWrites(observer, databaseUrl);
    const activationClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const priorDeploymentSha = process.env.DEPLOYMENT_SHA;
    process.env.DEPLOYMENT_SHA = currentSha;
    try {
      const readinessRace = createReadinessRaceClient(activationClient);
      const losingActivation = activateApplicationContract({ client: readinessRace.client, source: "ADMIN" });
      const activationResults = await (async () => {
        try {
          await waitUntil(() => Promise.resolve(readinessRace.isPaused()), "transaction-A readiness pause", 5_000);
          const winner = await activateApplicationContract({ client: activationClient, source: "ADMIN" });
          readinessRace.release();
          return [winner, await losingActivation] as const;
        } finally {
          readinessRace.release();
          await Promise.allSettled([losingActivation]);
        }
      })();
      const activationKinds = activationResults.map((result) => result.kind).sort();
      if (activationKinds.join(",") !== "activated,already_active") {
        throw new OperationalRolloutSmokeError(
          "ACTIVATION_CONCURRENCY_FAILED",
          `concurrent activation did not converge idempotently: ${activationKinds.join(",")}`
        );
      }
      const postActivationMutationRejected = await proveOldArtifactRejected(observer, appPort);
      const localV2OwnerDml = await proveOwnerDmlContract(observer);
      const marker = z.object({ activationSource: z.string(), consumedAt: z.coerce.date(), deploymentSha: FullShaSchema }).parse(
        (await observer.query(`
          SELECT receipt."activationSource",receipt."consumedAt",marker."deploymentSha"
          FROM "SchemaCompatibility" marker
          JOIN "ApplicationDeploymentReceipt" receipt ON receipt."id"=marker."activationReceiptId"
          WHERE marker."id"='discord-operations' AND marker."minimumApplicationContract"='discord-ops-v2'
        `)).rows[0]
      );
      if (marker.activationSource !== "ADMIN" || marker.deploymentSha !== currentSha) {
        throw new OperationalRolloutSmokeError("ACTIVATION_PROVENANCE_FAILED", "source-bound activation provenance mismatch");
      }
      scenario = {
        activation: {
          deploymentSha: activationResults[0].deploymentSha,
          interleaving: "TRANSACTION_A_READINESS_PAUSED",
          outcomes: activationKinds,
          source: activationResults[0].source
        },
        base: { buildId, sha: checkedOutBase },
        catalog,
        legacy,
        localV2OwnerDml,
        oldArtifact: { afterExpansion, beforeExpansion, duringIndexes, duringMigrations, postActivationMutationRejected },
        restrictedRole
      };
    } finally {
      if (priorDeploymentSha === undefined) delete process.env.DEPLOYMENT_SHA;
      else process.env.DEPLOYMENT_SHA = priorDeploymentSha;
      await activationClient.$disconnect();
    }
  } finally {
    try {
      if (locker !== undefined) await rollbackAndClose(locker);
      if (indexBlocker !== undefined) await rollbackAndClose(indexBlocker);
      if (observer !== undefined) await observer.end();
    } finally {
      try {
        await stopManagedChildren([indexes, migration, app]);
      } finally {
        try {
          await fakeDiscord?.close();
        } finally {
          try {
            if (substMapped && substDrive !== undefined) runCommandSync("subst", [`${substDrive}:`, "/D"], repositoryRoot);
            substMapped = false;
          } finally {
            try {
              if (worktreeAdded) await removeBaseWorktree(repositoryRoot, baseWorktree);
              await assertPathMissing(baseWorktree);
            } finally {
              try {
                if (databaseStarted) await embedded.stop();
              } finally {
                try {
                  await rm(databaseRoot, { force: true, recursive: true });
                } finally {
                  await releaseRolloutLockOnce();
                }
              }
            }
          }
        }
      }
    }
  }

  if (scenario === undefined) throw new OperationalRolloutSmokeError("ROLLOUT_INCOMPLETE", "rollout ended without a result");
  const [appPortFree, baseArtifactExists, databasePortFree, databaseRootExists, fakeDiscordPortFree, lockExists, substExists] = await Promise.all([
    isPortFree(appPort),
    pathExists(baseWorktree),
    isPortFree(databasePort),
    pathExists(databaseRoot),
    fakeDiscord === undefined ? Promise.resolve(false) : isPortFree(fakeDiscord.port),
    pathExists(rolloutLock.path),
    substDrive === undefined ? Promise.resolve(false) : pathExists(`${substDrive}:\\`)
  ]);
  if (!appPortFree || baseArtifactExists || !databasePortFree || databaseRootExists || !fakeDiscordPortFree || lockExists || substExists) {
    throw new OperationalRolloutSmokeError("TEARDOWN_FAILED", "rollout process, port, artifact, database, lock, or drive mapping survived cleanup");
  }
  const worktreeList = runCommandSync("git", ["worktree", "list", "--porcelain"], repositoryRoot).stdout;
  if (worktreeList.includes(baseWorktree)) {
    throw new OperationalRolloutSmokeError("TEARDOWN_FAILED", "detached base worktree metadata remains after cleanup");
  }
  return {
    cleanup: {
      appPortFree,
      baseArtifactRemoved: !baseArtifactExists,
      databasePortFree,
      databaseRootRemoved: !databaseRootExists,
      fakeDiscordPortFree,
      lockRemoved: !lockExists,
      substRemoved: !substExists
    },
    discordIsolation: {
      requests: fakeDiscord?.requests ?? [],
      target: "OWNED_LOOPBACK_FAKE"
    },
    evidenceLabel: "LOCAL_IMMUTABLE_BASE_ROLLOUT_NOT_PRODUCTION_CAPACITY",
    ok: true,
    ...scenario
  };
  } finally {
    await releaseRolloutLockOnce();
  }
}

function rolloutEnvironment(databaseUrl: string, appPort: number, attemptBaseSha: string, fakeDiscordUrl: string): NodeJS.ProcessEnv {
  const studentIds = ["rollout-a", "rollout-b", "rollout-c", "rollout-d"];
  return {
    ...process.env,
    ADMIN_STUDENT_NUMBERS: "99999",
    APP_ORIGIN: "https://rollout.invalid",
    CLOSED_PERIOD_CRON_SECRET: "closed-period-cron-secret-local",
    DATABASE_URL: databaseUrl,
    DEPLOYMENT_SHA: attemptBaseSha,
    DIRECT_URL: databaseUrl,
    DISCORD_FAKE_BASE_URL: fakeDiscordUrl,
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123456789/local-fixture-token",
    ENABLE_PRODUCTION_LOCAL_STUDENT: "true",
    LOCAL_STUDENT_LOGIN_ID: studentIds.join(","),
    LOCAL_STUDENT_LOGIN_PASSWORD: "rollout-student-secret",
    LOCAL_STUDENT_NUMBER: studentIds.map((_, index) => `9200${index + 1}`).join(","),
    MAINTENANCE_CRON_SECRET: "maintenance-cron-secret-local",
    NEXT_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: buildDiscordLoopbackNodeOptions(fakeDiscordUrl, process.env.NODE_OPTIONS),
    NODE_ENV: "production",
    PORT: String(appPort),
    SESSION_SECRET: "session-secret-for-local-rollout-only",
    TRUST_FORWARDED_IP_HEADERS: "true"
  };
}

async function preparePreExpansionDatabase(client: pg.Client): Promise<string> {
  const reservationDate = nextReservableKstDate(new Date());
  await client.query(`UPDATE "NotificationSetting" SET "closedPeriodNotificationsEnabled"=false,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"='global'`);
  await client.query(`
    INSERT INTO "PeriodSetting" ("id","date","studyPeriod","openTime","closeTime","capacity","enabled","createdAt","updatedAt")
    VALUES ('rollout-period-eighth',$1,'EIGHTH','00:00','23:59',20,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
           ('rollout-period-first',$1,'FIRST','00:00','23:59',20,true,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `, [reservationDate]);
  await client.query(`
    INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt") VALUES
      ('legacy-user-send','Legacy Send','legacy-send',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('legacy-user-sync','Legacy Sync','legacy-sync',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `);
  await client.query(`
    INSERT INTO "Reservation" ("id","date","studyPeriod","reason","userId","createdAt","updatedAt") VALUES
      ('legacy-reservation-send',$1,'EIGHTH','legacy-send','legacy-user-send',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('legacy-reservation-sync',$1,'FIRST','legacy-sync','legacy-user-sync',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `, [reservationDate]);
  await client.query(`
    INSERT INTO "DiscordReservationMessage" ("reservationId","nonce","initialSendStatus","syncStatus","messageId","messageRevision","syncedRevision","createdAt","updatedAt") VALUES
      ('legacy-reservation-send','legacy-send-nonce','SENDING','PENDING',NULL,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      ('legacy-reservation-sync','legacy-sync-nonce','SENT','SYNCING','legacy-message-sync',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `);
  return reservationDate;
}

function nextReservableKstDate(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  for (let offset = 1; offset <= 4; offset += 1) {
    const candidate = new Date(kst);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    const day = candidate.getUTCDay();
    if (day >= 1 && day <= 4) return candidate.toISOString().slice(0, 10);
  }
  throw new OperationalRolloutSmokeError("NO_RESERVABLE_DATE", "rollout requires a Monday-through-Thursday advance date");
}

async function driveOldArtifactTraffic(
  port: number,
  reservationDate: string,
  loginId: string,
  studyPeriod: "EIGHTH" | "FIRST"
): Promise<TrafficResult> {
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/riro/login`, {
    body: JSON.stringify({ id: loginId, password: "rollout-student-secret" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const loginBody = LoginResponseSchema.safeParse(await login.json());
  if (login.status !== 200 || !loginBody.success) {
    throw new OperationalRolloutSmokeError("OLD_LOGIN_FAILED", `old artifact login failed with ${login.status}`);
  }
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new OperationalRolloutSmokeError("OLD_LOGIN_FAILED", "old artifact login returned no session cookie");
  const csrf = await fetch(`http://127.0.0.1:${port}/api/csrf`, { headers: { cookie } });
  const csrfBody = CsrfResponseSchema.safeParse(await csrf.json());
  if (csrf.status !== 200 || !csrfBody.success) {
    throw new OperationalRolloutSmokeError("OLD_CSRF_FAILED", `old artifact CSRF failed with ${csrf.status}`);
  }
  const reservation = await fetch(`http://127.0.0.1:${port}/api/reservations`, {
    body: JSON.stringify({ date: reservationDate, reason: `rollout-${loginId}`, studyPeriod }),
    headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfBody.data.csrfToken },
    method: "POST"
  });
  if (reservation.status !== 201) {
    throw new OperationalRolloutSmokeError("OLD_RESERVATION_FAILED", `old artifact reservation failed with ${reservation.status}: ${await reservation.text()}`);
  }
  const cron = await fetch(`http://127.0.0.1:${port}/api/cron/maintenance`, {
    headers: { authorization: "Bearer maintenance-cron-secret-local" }
  });
  if (cron.status !== 200) {
    throw new OperationalRolloutSmokeError("OLD_CRON_FAILED", `old artifact cron failed with ${cron.status}: ${await cron.text()}`);
  }
  return { cronStatus: cron.status, loginStatus: login.status, reservationStatus: reservation.status, studentNumber: loginBody.data.user.studentNumber };
}

async function populateOnlineIndexFixture(client: pg.Client): Promise<void> {
  await client.query(`
    INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt")
    SELECT 'rollout-bulk-user-'||g,'김학생 '||g,'rollout-bulk-'||g,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    FROM generate_series(1,12000) g
  `);
  await client.query(`
    INSERT INTO "AdminAction" ("id","action","reason","createdAt")
    SELECT 'rollout-bulk-action-'||g,'ROLLOUT_ACTION','rollout reason '||g,CURRENT_TIMESTAMP
    FROM generate_series(1,12000) g
  `);
}

async function assertInactiveExpansion(client: pg.Client): Promise<void> {
  const marker = z.object({ activatedAt: z.null(), enabled: z.boolean(), minimumApplicationContract: z.string() }).parse(
    (await client.query(`
      SELECT marker."activatedAt",marker."minimumApplicationContract",control."enabled"
      FROM "SchemaCompatibility" marker CROSS JOIN "DiscordOperationsControl" control
      WHERE marker."id"='discord-operations' AND control."id"='discord-operations'
    `)).rows[0]
  );
  if (marker.enabled || marker.minimumApplicationContract !== "discord-ops-v1") {
    throw new OperationalRolloutSmokeError("EXPANSION_PREMATURELY_ACTIVE", "ordinary expansion did not remain inactive");
  }
}

async function classifyLegacyControls(client: pg.Client): Promise<readonly Record<string, unknown>[]> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL app.application_contract='discord-ops-v2'");
    await client.query("SET LOCAL app.current_user_role='SYSTEM'");
    await client.query(`
      UPDATE "DiscordReservationMessage" SET
        "initialSendStatus"=CASE WHEN "initialSendStatus"='SENDING' THEN 'PENDING_REVIEW' ELSE "initialSendStatus" END,
        "syncStatus"=CASE WHEN "syncStatus"='SYNCING' THEN 'PENDING_REVIEW' ELSE "syncStatus" END,
        "pendingReviewReason"=CASE WHEN "initialSendStatus"='SENDING' THEN 'LEGACY_SENDING' WHEN "syncStatus"='SYNCING' THEN 'LEGACY_SYNCING' ELSE "pendingReviewReason" END,
        "initialSendNextAttemptAt"=CASE WHEN "initialSendStatus"='SENDING' THEN NULL ELSE "initialSendNextAttemptAt" END,
        "syncNextAttemptAt"=CASE WHEN "syncStatus"='SYNCING' THEN NULL ELSE "syncNextAttemptAt" END,
        "legacyControlState"='LEGACY_INERT',"renderedSourceEpoch"=0,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "legacyControlState"='UNCLASSIFIED'
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const rows = LegacyRowsSchema.parse((await client.query(`
    SELECT "reservationId","initialSendStatus","syncStatus","pendingReviewReason","legacyControlState","renderedSourceEpoch"
    FROM "DiscordReservationMessage" WHERE "reservationId" LIKE 'legacy-reservation-%' ORDER BY "reservationId"
  `)).rows);
  if (rows.length !== 2 || rows.some((row) => row.legacyControlState !== "LEGACY_INERT" || row.renderedSourceEpoch !== 0) ||
      rows.some((row) => row.initialSendStatus === "SENDING" || row.syncStatus === "SYNCING")) {
    throw new OperationalRolloutSmokeError("LEGACY_CLASSIFICATION_FAILED", "legacy transport/control rows were not made inert review state");
  }
  return rows;
}

async function verifyRestrictedRoleWrites(owner: pg.Client, databaseUrl: string) {
  const password = randomBytes(24).toString("base64url");
  await owner.query(`ALTER ROLE info_room_runtime WITH LOGIN PASSWORD '${password}'`);
  const restrictedUrl = new URL(databaseUrl);
  restrictedUrl.username = "info_room_runtime";
  restrictedUrl.password = password;
  const restricted = await connect(restrictedUrl.toString());
  try {
    const receipt = await expectDatabaseRejection(restricted, `
      INSERT INTO "ApplicationDeploymentReceipt" ("id","deploymentSha","schemaContract","applicationContract","readinessDigest","activationSource","expiresAt")
      VALUES ('forbidden-receipt','${"f".repeat(40)}','discord-ops-v2','discord-ops-v2','forbidden','ADMIN',CURRENT_TIMESTAMP+INTERVAL '1 minute')
    `);
    const marker = await expectDatabaseRejection(restricted, `UPDATE "SchemaCompatibility" SET "deploymentSha"='${"f".repeat(40)}' WHERE "id"='discord-operations'`);
    const control = await expectDatabaseRejection(restricted, `UPDATE "DiscordOperationsControl" SET "epoch"="epoch"+1 WHERE "id"='discord-operations'`);
    return { control, marker, receipt } as const;
  } finally {
    await restricted.end();
  }
}

async function proveOldArtifactRejected(client: pg.Client, port: number): Promise<boolean> {
  const before = z.object({ buckets: z.coerce.number(), sessions: z.coerce.number(), users: z.coerce.number() }).parse(
    (await client.query(`SELECT (SELECT count(*) FROM "RateLimitBucket") buckets,(SELECT count(*) FROM "Session") sessions,(SELECT count(*) FROM "User") users`)).rows[0]
  );
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/riro/login`, {
    body: JSON.stringify({ id: "rollout-a", password: "rollout-student-secret" }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const after = z.object({ buckets: z.coerce.number(), sessions: z.coerce.number(), users: z.coerce.number() }).parse(
    (await client.query(`SELECT (SELECT count(*) FROM "RateLimitBucket") buckets,(SELECT count(*) FROM "Session") sessions,(SELECT count(*) FROM "User") users`)).rows[0]
  );
  if (response.status < 500 || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new OperationalRolloutSmokeError("OLD_ARTIFACT_WRITE_ACCEPTED", `old artifact returned ${response.status} or mutated guarded tables`);
  }
  return true;
}

async function proveOwnerDmlContract(client: pg.Client) {
  const missingContextRejected = (await expectDatabaseRejection(client, `
    INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt")
    VALUES ('owner-no-context','Owner','owner-no-context',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
  `)) !== "";
  await client.query("BEGIN");
  let wrongContextRejected = false;
  try {
    await client.query("SET LOCAL app.application_contract='discord-ops-v1'");
    await client.query(`INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt") VALUES ('owner-wrong-context','Owner','owner-wrong-context',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    await client.query("ROLLBACK");
  } catch (error) {
    wrongContextRejected = true;
    await client.query("ROLLBACK");
    if (!(error instanceof Error)) throw error;
  }
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL app.application_contract='discord-ops-v2'");
    await client.query("SET LOCAL app.current_user_role='SYSTEM'");
    await client.query(`INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt") VALUES ('owner-v2-context','Owner','owner-v2-context',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const succeededWithContext = Number((await client.query(`SELECT count(*) FROM "User" WHERE "id"='owner-v2-context'`)).rows[0]?.count) === 1;
  if (!missingContextRejected || !wrongContextRejected || !succeededWithContext) {
    throw new OperationalRolloutSmokeError("OWNER_DML_CONTRACT_FAILED", "post-activation owner DML contract was not fail-closed");
  }
  return { missingContextRejected, succeededWithContext, wrongContextRejected } as const;
}

async function verifyOnlineIndexState(client: pg.Client) {
  const ledger = z.object({ checksum: z.string(), state: z.string() }).parse(
    (await client.query("SELECT checksum,state FROM app_private.online_schema_migrations WHERE name='admin-search-indexes-v1'")).rows[0]
  );
  const rows = z.array(z.object({ name: z.string(), ready: z.boolean(), valid: z.boolean() })).parse((await client.query(`
    SELECT c.relname name,i.indisready ready,i.indisvalid valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE c.relname=ANY($1) ORDER BY c.relname
  `, [ONLINE_INDEX_MANIFEST.map(({ name }) => name)])).rows);
  const expected = ONLINE_INDEX_MANIFEST.map(({ name }) => name).sort();
  const actual = rows.map(({ name }) => name).sort();
  if (ledger.state !== "APPLIED" || ledger.checksum !== ONLINE_INDEX_CHECKSUM || rows.some((row) => !row.ready || !row.valid) ||
      JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new OperationalRolloutSmokeError("ONLINE_INDEX_VERIFICATION_FAILED", "ledger checksum/APPLIED/catalog state mismatch");
  }
  return { checksum: ledger.checksum, indexes: actual, state: ledger.state } as const;
}

async function expectDatabaseRejection(client: pg.Client, sql: string): Promise<string> {
  try {
    await client.query(sql);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : error.name;
  }
  throw new OperationalRolloutSmokeError("RESTRICTED_WRITE_ACCEPTED", "database accepted a write that must be rejected");
}

async function waitForBlockedMigration(client: pg.Client, child: ManagedChild): Promise<void> {
  await waitUntil(async () => {
    assertChildAlive(child, "ordinary Prisma expansion");
    const result = await client.query(`
      SELECT count(*)::int count FROM pg_locks
      WHERE locktype='advisory' AND NOT granted
    `);
    return Number(result.rows[0]?.count) > 0;
  }, "ordinary migration paused without locking application tables", 20_000);
}

async function installMigrationPause(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE FUNCTION public.todo20_pause_migration() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_lock(${MIGRATION_PAUSE_ADVISORY_KEY});
      PERFORM pg_advisory_unlock(${MIGRATION_PAUSE_ADVISORY_KEY});
    END
    $$
  `);
  await client.query(`
    CREATE EVENT TRIGGER todo20_pause_migration
    ON ddl_command_start EXECUTE FUNCTION public.todo20_pause_migration()
  `);
}

async function waitForDatabaseStatement(client: pg.Client, child: ManagedChild, fragment: string): Promise<void> {
  await waitUntil(async () => {
    assertChildAlive(child, "online index runner");
    const result = await client.query("SELECT count(*)::int count FROM pg_stat_activity WHERE query LIKE $1 AND pid <> pg_backend_pid()", [`%${fragment}%`]);
    return Number(result.rows[0]?.count) > 0;
  }, `database statement ${fragment}`, 20_000);
}

async function waitUntil(predicate: () => Promise<boolean>, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new OperationalRolloutSmokeError("WAIT_TIMEOUT", `timed out waiting for ${label}`);
}

function startManaged(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): ManagedChild {
  const child = spawn(command, args, { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }>((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", (status) => resolveClose({ exitCode: status ?? -1, stderr, stdout }));
  });
  return { child, closed };
}

function requireSuccessfulChild(result: { readonly exitCode: number; readonly stderr: string; readonly stdout: string }, label: string): void {
  if (result.exitCode !== 0) {
    throw new OperationalRolloutSmokeError("CHILD_FAILED", `${label} exited ${result.exitCode}: ${result.stderr || result.stdout}`);
  }
}

function assertChildAlive(child: ManagedChild, label: string): void {
  if (child.child.exitCode !== null) throw new OperationalRolloutSmokeError("CHILD_EXITED", `${label} exited before the required overlap`);
}

async function stopManaged(managed: ManagedChild | undefined): Promise<void> {
  if (managed === undefined) return;
  if (process.platform === "win32" && managed.child.pid !== undefined) {
    const pid = managed.child.pid;
    if (!processExists(pid)) return;
    const killed = spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { encoding: "utf8", shell: false, windowsHide: true });
    if (killed.status !== 0 && processExists(pid)) {
      throw new OperationalRolloutSmokeError("TEARDOWN_FAILED", `taskkill failed: ${killed.stderr || killed.stdout}`);
    }
    await waitUntil(async () => !processExists(pid), `child process ${pid} teardown`, 10_000);
  } else {
    if (managed.child.exitCode !== null) return;
    managed.child.kill("SIGTERM");
    await Promise.race([managed.closed, new Promise((_, rejectWait) => setTimeout(() => rejectWait(
      new OperationalRolloutSmokeError("TEARDOWN_FAILED", "child process did not stop")
    ), 10_000))]);
  }
}

async function stopManagedChildren(children: readonly (ManagedChild | undefined)[]): Promise<void> {
  const results = await Promise.allSettled(children.map(stopManaged));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ESRCH") return false;
    throw error;
  }
}

async function waitForApp(port: number, app: ManagedChild): Promise<void> {
  await waitUntil(async () => {
    assertChildAlive(app, "built base app");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      return response.status < 500;
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  }, "built base app readiness", 30_000);
}

function runCommandSync(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env, timeout = 120_000) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, maxBuffer: 20 * 1024 * 1024, shell: false, timeout, windowsHide: true });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new OperationalRolloutSmokeError("CHILD_FAILED", `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`);
  return { stdout: result.stdout, stderr: result.stderr } as const;
}

function runNodeCommandSync(entry: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): void {
  runCommandSync(process.execPath, [entry, ...args], cwd, env, timeout);
}

async function resolveNpmCli(): Promise<string> {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") throw error;
    }
  }
  throw new OperationalRolloutSmokeError("NPM_CLI_MISSING", "unable to locate npm CLI for independent base install/build");
}

async function connect(connectionString: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

async function rollbackAndClose(client: pg.Client): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
}

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => rejectPort(new OperationalRolloutSmokeError("PORT_ALLOCATION_FAILED", "loopback port allocation failed")));
        return;
      }
      server.close((error) => error === undefined ? resolvePort(address.port) : rejectPort(error));
    });
  });
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

async function findFreeSubstDrive(): Promise<string> {
  const occupied: string[] = [];
  for (const drive of SUBST_DRIVE_CANDIDATES) {
    try {
      await access(`${drive}:\\`);
      occupied.push(drive);
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "ENOENT") occupied.push(drive);
    }
  }
  return selectFreeSubstDrive(occupied);
}

async function removeBaseWorktree(repositoryRoot: string, baseWorktree: string): Promise<void> {
  const removal = spawnSync("git", ["worktree", "remove", "--force", baseWorktree], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: false,
    windowsHide: true
  });
  if (removal.error !== undefined) throw removal.error;
  if (await pathExists(baseWorktree)) {
    await removeReparsePoints(baseWorktree);
    const namespaced = process.platform === "win32" ? toNamespacedPath(baseWorktree) : baseWorktree;
    await rm(namespaced, { force: true, maxRetries: 10, recursive: true, retryDelay: 200 });
  }
  runCommandSync("git", ["worktree", "prune"], repositoryRoot);
  if (removal.status !== 0 && await pathExists(baseWorktree)) {
    throw new OperationalRolloutSmokeError("TEARDOWN_FAILED", `Git worktree removal failed: ${removal.stderr || removal.stdout}`);
  }
}

async function removeReparsePoints(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        const childRelative = relative(root, child);
        if (childRelative.startsWith("..") || isAbsolute(childRelative)) {
          throw new OperationalRolloutSmokeError("UNSAFE_PATH", `reparse point escaped rollout root: ${child}`);
        }
        await unlink(child);
      } else if (stat.isDirectory()) {
        pending.push(child);
      }
    }
  }
}

export async function acquireRolloutLock(attemptDir: string): Promise<RolloutLock> {
  const lockPath = join(attemptDir, "todo20-rollout.lock");
  const deadline = Date.now() + ROLLOUT_LOCK_WAIT_MS;
  let handle: FileHandle | undefined;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new OperationalRolloutSmokeError("ROLLOUT_ALREADY_RUNNING", "timed out waiting for the Todo 20 rollout lock");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  } catch (error) {
    await handle.close();
    await unlink(lockPath);
    throw error;
  }
  return { handle, path: lockPath };
}

export async function releaseRolloutLock(lock: RolloutLock): Promise<void> {
  try {
    await lock.handle.close();
  } finally {
    await unlink(lock.path);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false;
    throw error;
  }
}

function assertExactChild(parent: string, child: string, expectedName: string): void {
  if (relative(parent, child) !== expectedName || resolve(child) === resolve(parent)) {
    throw new OperationalRolloutSmokeError("UNSAFE_PATH", `unsafe rollout cleanup target: ${child}`);
  }
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return;
    throw error;
  }
  throw new OperationalRolloutSmokeError("WORKTREE_PATH_EXISTS", `rollout path already exists or survived cleanup: ${path}`);
}

async function runTransportFreeWorkerSchedule(items: number, batchSize: number) {
  let scheduled = 0;
  let invocations = 0;
  while (scheduled < items) {
    const batch = Math.min(batchSize, items - scheduled);
    const claims = Array.from({ length: batch }, (_, index) => transportClaim(scheduled + index));
    let completed = 0;
    const result = await runDiscordInteractionJobs({
      dispatch: async () => ({ kind: "succeeded", terminalResult: { profile: "transport_free" } }),
      now: new Date("2026-08-18T00:00:00.000Z"),
      store: {
        claim: async () => claims,
        completeFailure: async () => { throw new TypeError("Transport-free scheduling must not fail a claim"); },
        completeStale: async () => { throw new TypeError("Transport-free scheduling must not stale a claim"); },
        completeSuccess: async () => { completed += 1; },
        isDispatchAllowed: async () => true
      }
    });
    if (result.claimed !== batch || result.succeeded !== batch || completed !== batch) {
      throw new OperationalRolloutSmokeError("SCHEDULING_CAPACITY_FAILED", "Discord worker did not persist every scheduled item");
    }
    scheduled += batch;
    invocations += 1;
  }
  return { invocations, items: scheduled, worker: "runDiscordInteractionJobs" } as const;
}

async function runTransportProfile(tasks: readonly TransportTask[], deadlineMs: number) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  const outcomes: TransportOutcome[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const task = tasks[index];
      if (task === undefined) return;
      outcomes.push(await runWorkerTransportTask(task, index, controller.signal));
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(TRANSPORT_CONCURRENCY, tasks.length) }, worker));
  } finally {
    clearTimeout(deadline);
  }
  return {
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    rateLimited: outcomes.filter((outcome) => outcome === "rate_limited").length,
    sent: outcomes.filter((outcome) => outcome === "sent").length,
    timeout: outcomes.filter((outcome) => outcome === "timeout").length
  } as const;
}

async function runWorkerTransportTask(
  task: TransportTask,
  index: number,
  signal: AbortSignal
): Promise<TransportOutcome> {
  const claim = transportClaim(index);
  let persisted: TransportOutcome | null = null;
  const store: DiscordInteractionJobStore = {
    claim: async () => [claim],
    completeFailure: async ({ result }) => {
      if (result.status !== "RETRY" || result.nextAttemptAt === null) {
        throw new TypeError("Fake transport failure must remain retryable");
      }
      persisted = result.errorCode === "discord_http_429"
        ? "rate_limited"
        : result.errorCode === "discord_timeout"
          ? "timeout"
          : "failed";
    },
    completeStale: async () => { throw new TypeError("Fake transport claim must not become stale"); },
    completeSuccess: async () => { persisted = "sent"; },
    isDispatchAllowed: async () => true
  };
  await runDiscordInteractionJobs({
    dispatch: async () => {
      const outcome = await runTransportTask(task, signal);
      switch (outcome) {
        case "sent": return { kind: "succeeded" as const, terminalResult: { profile: "fake_transport" } };
        case "rate_limited": return { errorCode: "discord_http_429", errorType: "RATE_LIMIT", kind: "retryable_failure" as const };
        case "timeout": return { errorCode: "discord_timeout", errorType: "TIMEOUT", kind: "retryable_failure" as const };
        case "failed": return { errorCode: "discord_5xx", errorType: "UPSTREAM", kind: "retryable_failure" as const };
      }
    },
    now: new Date("2026-08-18T00:00:00.000Z"),
    store
  });
  if (persisted === null) {
    throw new OperationalRolloutSmokeError("TRANSPORT_PROFILE_FAILED", "Discord worker did not persist the fake transport outcome");
  }
  return persisted;
}

function transportClaim(index: number): DiscordInteractionJobClaim {
  const id = String(index).padStart(3, "0");
  return {
    attempts: 1,
    claimId: `capacity-claim-${id}`,
    commandDigest: `sha256:capacity-${id}`,
    discordActorId: "capacity-discord-admin",
    interactionId: `capacity-interaction-${id}`,
    intent: "capacity",
    ipHash: "sha256:capacity-ip",
    localActorId: "capacity-admin",
    renderedEpoch: 1,
    reservationId: `capacity-reservation-${id}`,
    sourceApplicationId: "capacity-application",
    sourceChannelId: "capacity-channel",
    sourceGuildId: "capacity-guild",
    sourceMessageId: `capacity-message-${id}`
  };
}

function runTransportTask(task: TransportTask, signal: AbortSignal): Promise<TransportOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve("timeout"); return; }
    let settled = false;
    const finish = (outcome: TransportOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish("timeout");
    const timeout = setTimeout(() => finish(task.outcome), task.delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function buildDiscordLoopbackNodeOptions(target: string, inherited = ""): string {
  const base = new URL(z.string().url().parse(target));
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username !== "" || base.password !== ""
  ) {
    throw new OperationalRolloutSmokeError("UNSAFE_FAKE_DISCORD_URL", "fake Discord target must be credential-free loopback HTTP");
  }
  const preload = Buffer.from(`
const base = new URL(process.env.DISCORD_FAKE_BASE_URL);
if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.username || base.password) {
  throw new TypeError("Unsafe fake Discord target");
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const source = input instanceof Request ? input.url : String(input);
  const url = new URL(source);
  if (url.hostname === "discord.com") {
    const replacement = new URL(url.pathname + url.search, base);
    return input instanceof Request
      ? nativeFetch(new Request(replacement, input), init)
      : nativeFetch(replacement, init);
  }
  return nativeFetch(input, init);
};
`, "utf8").toString("base64");
  return `${inherited} --import=data:text/javascript;base64,${preload}`.trim();
}

async function startRolloutFakeDiscord(): Promise<RolloutFakeDiscord> {
  const requests: string[] = [];
  const server = createHttpServer((incoming, response) => {
    requests.push(`${incoming.method ?? "UNKNOWN"} ${incoming.url ?? "/"}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(incoming.method === "GET" ? JSON.stringify({ roles: [] }) : JSON.stringify({ id: "rollout-fake-message" }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeHttpServer(server);
    throw new OperationalRolloutSmokeError("FAKE_DISCORD_START_FAILED", "rollout fake Discord did not bind a loopback port");
  }
  return {
    close: () => closeHttpServer(server),
    port: address.port,
    requests,
    url: `http://127.0.0.1:${address.port}`
  };
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

function assertNever(value: never): never {
  throw new OperationalRolloutSmokeError("UNEXPECTED_PROFILE", `Unexpected operational profile: ${String(value)}`);
}

class OperationalRolloutSmokeError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OperationalRolloutSmokeError";
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => { // no-excuse-ok: catch
    process.stderr.write(`${error instanceof Error ? error.message : "Operational rollout smoke failed"}\n`);
    process.exit(1);
  });
}
