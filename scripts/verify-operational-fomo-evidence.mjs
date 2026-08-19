#!/usr/bin/env node
// allow: SIZE_OK — one final-evidence boundary owns strict parsing, Git proofs, QA routing, and cleanup probes.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync
} from "node:fs";
import { get } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";
import pg from "pg";

const TODO_COUNT = 21;
const READINESS_DIGEST = "c99eebbeec6b76f35bce411575d3f03614703fa528d27964cce6989b5356e2b4";
const DEPLOYMENT_SHA = "b".repeat(40);
const activeChildren = new Set();
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true });
const identityScalarSchema = z.union([z.string().min(1), z.number().finite().nonnegative()]);
const baselineSchema = z.object({ todo: z.number().int().min(1).max(TODO_COUNT), commitSha: shaSchema }).strict();
const descriptorSchema = z.object({
  canonicalRoot: z.string().min(1),
  ancestors: z.array(z.object({
    segment: z.string().min(1), volume: identityScalarSchema, fileIndex: identityScalarSchema
  }).strict()),
  target: z.object({
    path: z.string().min(1), regularFile: z.literal(true), volume: identityScalarSchema,
    fileIndex: identityScalarSchema, sha256: digestSchema
  }).strict()
}).strict();
const reviewSchema = z.object({
  descriptor: descriptorSchema,
  roundId: z.string().min(1), status: z.literal("approved"), roundStatus: z.literal("approved"),
  planPath: z.string().min(1), planSha256: digestSchema,
  momusLaunchId: z.string().min(1), momusSessionId: z.string().min(1),
  independentLaunchId: z.string().min(1), independentSessionId: z.string().min(1),
  momusReviewedHeadSha: shaSchema, momusReviewedTreeSha: shaSchema, momusReviewedClean: z.literal(true),
  independentReviewedHeadSha: shaSchema, independentReviewedTreeSha: shaSchema,
  independentReviewedClean: z.literal(true), executionBaseSha: shaSchema, executionBaseTreeSha: shaSchema
}).strict();
const attemptSchema = z.object({
  schemaVersion: z.literal(1), slug: z.literal("operational-fomo-upgrade"),
  attemptBaseSha: shaSchema, attemptBaseTreeSha: shaSchema, todo1CommitSha: shaSchema,
  sourceWorkspaceRoot: z.string().min(1), boundPlanPath: z.string().min(1),
  planDescriptorReceipt: descriptorSchema,
  descriptorScript: z.object({
    path: z.string().min(1), sha256: digestSchema, volume: identityScalarSchema, fileIndex: identityScalarSchema
  }).strict(),
  reviewReceipt: reviewSchema,
  createdAt: timestampSchema
}).strict();
const commandSchema = z.object({
  workingDirectory: z.string().min(1), argv: z.array(z.string()).min(1),
  startedAt: timestampSchema, finishedAt: timestampSchema, exitCode: z.literal(0), timedOut: z.literal(false),
  commitSha: shaSchema, testedTreeSha: shaSchema, cleanBefore: z.literal(true), cleanAfter: z.literal(true),
  outputPath: z.string().min(1), outputSha256: digestSchema
}).strict();
const evidenceSchema = z.object({ path: z.string().min(1), kind: z.enum(["image", "text"]), sha256: digestSchema }).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), planSha256: digestSchema, attemptBaseSha: shaSchema,
  todo: z.number().int().min(1).max(TODO_COUNT),
  startMode: z.enum(["retrospective_bootstrap", "pre_edit"]), taskStartSha: shaSchema,
  baselineTasks: z.array(baselineSchema), commitSha: shaSchema, testedTreeSha: shaSchema,
  status: z.literal("passed"), commands: z.array(commandSchema).min(1),
  evidence: z.array(evidenceSchema).min(1), changedPaths: z.array(z.string().min(1)).min(1)
}).strict();
const integrationSchema = z.object({
  schemaVersion: z.literal(1), todo: z.number().int().min(1).max(TODO_COUNT),
  mode: z.enum(["serial_bootstrap", "no_ff_merge"]), taskCommitSha: shaSchema,
  integrationCommitSha: shaSchema, integratedTreeSha: shaSchema, manifestSha256: digestSchema
}).strict();
const optionsSchema = z.object({
  mode: z.enum(["compliance", "scope", "cleanup", "core", "attempt"]),
  attemptDir: z.string().min(1).optional(), workspace: z.string().min(1).optional(),
  phase: z.enum(["database", "browser", "discord", "full"]).optional(),
  childArgv: z.array(z.string()), ci: z.boolean()
}).strict();

export class OperationalEvidenceError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OperationalEvidenceError";
    this.code = code;
  }
}

export function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const childArgv = separator === -1 ? [] : argv.slice(separator + 1);
  const values = new Map();
  const allowed = new Set(["--ci", "--mode", "--attempt-dir", "--workspace", "--phase"]);
  for (let index = 0; index < own.length; index += 1) {
    const key = own[index];
    if (key === "--ci") {
      if (values.has(key)) fail("ARGUMENT", "invalid arguments: duplicate --ci");
      values.set(key, true);
      continue;
    }
    const value = own[index + 1];
    if (!allowed.has(key) || values.has(key) || value === undefined || value.length === 0) {
      fail("ARGUMENT", `invalid arguments: ${key ?? "missing option"}`);
    }
    values.set(key, value);
    index += 1;
  }
  const parsed = optionsSchema.safeParse({
    mode: values.get("--mode"), attemptDir: values.get("--attempt-dir"),
    workspace: values.get("--workspace"), phase: values.get("--phase"), childArgv, ci: values.get("--ci") === true
  });
  if (!parsed.success) fail("ARGUMENT", `invalid arguments: ${formatIssues(parsed.error)}`);
  const options = parsed.data;
  if (["compliance", "scope", "cleanup", "attempt"].includes(options.mode) && options.attemptDir === undefined) {
    fail("ARGUMENT", "invalid arguments: --attempt-dir is required");
  }
  if (["core", "attempt"].includes(options.mode) && options.phase === undefined) {
    fail("ARGUMENT", "invalid arguments: --phase is required");
  }
  if (options.mode !== "core" && options.ci) fail("ARGUMENT", "invalid arguments: --ci is core-only");
  return options;
}

export async function execute(argv) {
  const options = parseArguments(argv);
  const workspace = resolve(options.workspace ?? process.cwd());
  switch (options.mode) {
    case "compliance": return verifyCompliance(resolve(options.attemptDir), workspace);
    case "scope": return verifyScope(resolve(options.attemptDir), workspace);
    case "cleanup": return verifyCleanup(resolve(options.attemptDir), workspace);
    case "core": return runPortableCore(options.phase, options.childArgv, options.ci);
    case "attempt": {
      const attemptDir = resolve(options.attemptDir);
      validateAttemptIdentity(attemptDir);
      return runPortableCore(options.phase, options.childArgv, false, attemptDir);
    }
    default: return assertNever(options.mode);
  }
}

function verifyCompliance(attemptDir, workspace) {
  const graph = loadGraph(attemptDir, workspace, true);
  const intersections = parallelWriteSetIntersections(graph.dependencies, graph.writeSets);
  if (intersections.length > 0) fail("PARALLEL_SCOPE", `parallel expanded write-set intersections: ${intersections.join(", ")}`);
  process.stdout.write(
    `Operational evidence compliance passed: ${graph.manifests.size}/${TODO_COUNT} task manifests; ` +
    `${graph.integrations.size}/${TODO_COUNT} integration receipts; undeclaredPaths=0; ` +
    `parallelWriteSetIntersections=0; missingGuardrailOutcomes=0\n`
  );
}

function verifyScope(attemptDir, workspace) {
  rejectForbiddenManifestPaths(attemptDir);
  const graph = loadGraph(attemptDir, workspace, false);
  git(workspace, ["diff", "--check", `${graph.attempt.attemptBaseSha}...HEAD`]);
  const finalPaths = lines(git(workspace, ["diff", "--name-only", `${graph.attempt.attemptBaseSha}...HEAD`]));
  const recordedPaths = new Set(
    [...graph.manifests.values()].flatMap((manifest) => manifest.changedPaths)
  );
  const unrecordedPaths = finalPaths.filter((path) => !recordedPaths.has(path));
  if (unrecordedPaths.length > 0) {
    fail("SCOPE", `final diff contains unrecorded paths: ${unrecordedPaths.join(", ")}`);
  }
  const forbidden = [];
  for (const manifest of graph.manifests.values()) {
    for (const path of manifest.changedPaths) {
      if (!matchesAny(path, graph.writeSets.get(manifest.todo) ?? [])) {
        fail("SCOPE", `changed path is not mapped to an approved todo: ${path}`);
      }
      if (/(^|\/)(?:vendor|vendors|scheduler|gateway|secrets?|credentials?)(\/|$)|bulk[-_/]?(?:no[-_]?show|ban|blacklist|restriction|sanction)/iu.test(path)) {
        forbidden.push(path);
      }
    }
  }
  if (forbidden.length > 0) fail("SCOPE", `forbidden path: ${[...new Set(forbidden)].join(", ")}`);
  const outcomeTodos = [
    [4, 14, 18], [1, 2, 5, 6, 7, 8, 9, 10, 11, 20], [15], [3, 12, 13, 16, 17], [19, 20, 21]
  ];
  const outcomes = outcomeTodos.filter((todos) => todos.some((todo) => (graph.manifests.get(todo)?.changedPaths.length ?? 0) > 0));
  if (outcomes.length !== 5) fail("SCOPE", `approved outcomes present: ${outcomes.length}/5`);
  process.stdout.write(`Operational scope passed: outcomes=5/5; forbiddenPaths=0; unmappedPaths=0\n`);
}

function rejectForbiddenManifestPaths(attemptDir) {
  const forbidden = [];
  for (let todo = 1; todo <= TODO_COUNT; todo += 1) {
    const manifest = parseFile(
      resolve(attemptDir, `task-${todo}-operational-fomo-upgrade.manifest.json`), manifestSchema, `task ${todo} manifest`
    );
    forbidden.push(...manifest.changedPaths.filter((path) =>
      /(^|\/)(?:vendor|vendors|scheduler|gateway|secrets?|credentials?)(\/|$)|bulk[-_/]?(?:no[-_]?show|ban|blacklist|restriction|sanction)/iu.test(path)
    ));
  }
  if (forbidden.length > 0) fail("SCOPE", `forbidden path: ${[...new Set(forbidden)].join(", ")}`);
}

async function verifyCleanup(attemptDir, workspace) {
  validateAttemptIdentity(attemptDir);
  const leaks = [];
  for (const path of [".next", "test-results", "tsconfig.tsbuildinfo", "prisma/dev.db"]) {
    if (existsSync(resolve(workspace, path))) leaks.push(path);
  }
  const nextEnv = resolve(workspace, "next-env.d.ts");
  if (existsSync(nextEnv)) {
    const status = git(workspace, ["status", "--porcelain", "--", "next-env.d.ts"]);
    if (status.length > 0) leaks.push("next-env.d.ts drift");
  }
  for (const entry of readdirSync(workspace, { withFileTypes: true })) {
    if (entry.isFile() && /(?:credential|secret|\.env\.operational|\.tmp$)/iu.test(entry.name)) leaks.push(entry.name);
  }
  const cleanupPath = resolve(attemptDir, "cleanup-receipt.json");
  if (existsSync(cleanupPath)) {
    const receipt = z.object({
      schemaVersion: z.literal(1), ownedPort: z.number().int().min(1).max(65535),
      ownedDataDirectory: z.string().min(1), ownedProcesses: z.array(z.object({ pid: z.number().int().positive(), cleaned: z.literal(true) }).strict()),
      ownedPortListeners: z.literal(0), postgresProcesses: z.literal(0), embeddedPostgresRoots: z.literal(0),
      recorderTemporaryRoots: z.literal(0), partialInitTemporaryRoots: z.literal(0)
    }).passthrough().parse(readJson(cleanupPath, "cleanup receipt"));
    if (existsSync(receipt.ownedDataDirectory)) leaks.push(`owned data directory ${receipt.ownedDataDirectory}`);
    if (await portHasListener(receipt.ownedPort)) leaks.push(`owned port ${receipt.ownedPort}`);
    for (const process of receipt.ownedProcesses) {
      if (processExists(process.pid)) leaks.push(`owned process ${process.pid}`);
    }
  }
  if (leaks.length > 0) fail("CLEANUP", `cleanup leakage: ${leaks.join(", ")}`);
  process.stdout.write("Operational cleanup passed: cleanupLeaks=0; generatedArtifacts=0; ownedResources=0\n");
}

function loadGraph(attemptDir, workspace, verifyArtifacts) {
  const attempt = validateAttemptIdentity(attemptDir);
  const planText = readFileSync(attempt.boundPlanPath, "utf8");
  const dependencies = parseDependencies(planText);
  const writeSets = parseWriteSets(planText);
  if (dependencies.size !== TODO_COUNT || writeSets.size !== TODO_COUNT) fail("PLAN", "plan must define 21 dependencies and write sets");
  const manifests = new Map();
  const integrations = new Map();
  const head = git(workspace, ["rev-parse", "HEAD"]);
  const history = gitHistory(workspace, head);
  for (let todo = 1; todo <= TODO_COUNT; todo += 1) {
    const manifestPath = resolve(attemptDir, `task-${todo}-operational-fomo-upgrade.manifest.json`);
    const integrationPath = resolve(attemptDir, `task-${todo}-integration.json`);
    const manifest = parseFile(manifestPath, manifestSchema, `task ${todo} manifest`);
    const integration = parseFile(integrationPath, integrationSchema, `task ${todo} integration receipt`);
    if (manifest.todo !== todo || integration.todo !== todo) fail("EVIDENCE", `task ${todo} record number mismatch`);
    if (manifest.planSha256 !== attempt.planDescriptorReceipt.target.sha256 || manifest.attemptBaseSha !== attempt.attemptBaseSha) {
      fail("EVIDENCE", `task ${todo} immutable attempt binding mismatch`);
    }
    if (sha256File(manifestPath) !== integration.manifestSha256) fail("EVIDENCE", `task ${todo} manifest digest mismatch`);
    const taskCommit = history.get(manifest.commitSha);
    const integrationCommit = history.get(integration.integrationCommitSha);
    if (taskCommit === undefined || integrationCommit === undefined || integration.taskCommitSha !== manifest.commitSha ||
        manifest.testedTreeSha !== taskCommit.tree || integration.integratedTreeSha !== integrationCommit.tree) {
      fail("EVIDENCE", `task ${todo} commit or tested tree mismatch`);
    }
    if (!isHistoryAncestor(history, manifest.commitSha, head) || !isHistoryAncestor(history, integration.integrationCommitSha, head)) {
      fail("ANCESTRY", `task ${todo} commit or integration receipt is not an ancestor of HEAD`);
    }
    if (taskCommit.parents.length !== 1 || taskCommit.parents[0] !== manifest.taskStartSha) {
      fail("ANCESTRY", `task ${todo} is not one commit from its recorded task start`);
    }
    const expectedChanged = taskCommit.changedPaths;
    if (!equalSets(expectedChanged, manifest.changedPaths)) fail("SCOPE", `task ${todo} changedPaths are not task-start-relative`);
    const declared = writeSets.get(todo) ?? [];
    const undeclared = manifest.changedPaths.filter((path) => !matchesAny(path, declared));
    if (undeclared.length > 0) fail("SCOPE", `task ${todo} undeclared paths: ${undeclared.join(", ")}`);
    const dependenciesForTask = dependencies.get(todo) ?? [];
    const baseline = new Map(manifest.baselineTasks.map((item) => [item.todo, item.commitSha]));
    for (const dependency of dependenciesForTask) {
      const dependencyManifest = manifests.get(dependency);
      if (dependencyManifest === undefined || baseline.get(dependency) !== dependencyManifest.commitSha ||
          !isHistoryAncestor(history, dependencyManifest.commitSha, manifest.taskStartSha)) {
        fail("DEPENDENCY", `task ${todo} baseline is missing dependency ${dependency}`);
      }
    }
    if (verifyArtifacts) verifyManifestArtifacts(manifest, attemptDir);
    manifests.set(todo, manifest);
    integrations.set(todo, integration);
  }
  return { attempt, dependencies, integrations, manifests, writeSets };
}

function validateAttemptIdentity(attemptDir) {
  const attemptPath = resolve(attemptDir, "attempt.json");
  const attempt = parseFile(attemptPath, attemptSchema, "attempt identity");
  verifyFileIdentity(attempt.descriptorScript, "descriptor script");
  verifyDescriptor(attempt.planDescriptorReceipt, "plan");
  verifyDescriptor(attempt.reviewReceipt.descriptor, "review receipt");
  if (attempt.reviewReceipt.planSha256 !== attempt.planDescriptorReceipt.target.sha256 ||
      attempt.reviewReceipt.executionBaseSha !== attempt.attemptBaseSha ||
      attempt.reviewReceipt.executionBaseTreeSha !== attempt.attemptBaseTreeSha ||
      attempt.reviewReceipt.momusReviewedHeadSha !== attempt.attemptBaseSha ||
      attempt.reviewReceipt.independentReviewedHeadSha !== attempt.attemptBaseSha ||
      attempt.reviewReceipt.momusReviewedTreeSha !== attempt.attemptBaseTreeSha ||
      attempt.reviewReceipt.independentReviewedTreeSha !== attempt.attemptBaseTreeSha ||
      attempt.reviewReceipt.momusLaunchId === attempt.reviewReceipt.independentLaunchId ||
      attempt.reviewReceipt.momusSessionId === attempt.reviewReceipt.independentSessionId) {
    fail("IDENTITY", "attempt identity reviewer/base binding mismatch");
  }
  const review = parseReviewReceipt(readFileSync(attempt.reviewReceipt.descriptor.target.path, "utf8"));
  for (const [key, value] of Object.entries(review)) {
    if (attempt.reviewReceipt[key] !== value) fail("IDENTITY", `attempt identity review field drift: ${key}`);
  }
  return attempt;
}

function verifyManifestArtifacts(manifest, attemptDir) {
  for (const command of manifest.commands) {
    if (command.commitSha !== manifest.commitSha || command.testedTreeSha !== manifest.testedTreeSha ||
        new Date(command.finishedAt).getTime() < new Date(command.startedAt).getTime()) {
      fail("COMMAND", `task ${manifest.todo} command clean-tree receipt mismatch`);
    }
    const path = evidencePath(attemptDir, command.outputPath, `task ${manifest.todo} command output`);
    if (sha256File(path) !== command.outputSha256) fail("COMMAND", `task ${manifest.todo} command output digest mismatch`);
  }
  for (const evidence of manifest.evidence) {
    const path = evidencePath(attemptDir, evidence.path, `task ${manifest.todo} evidence`);
    if (statSync(path).size === 0 || sha256File(path) !== evidence.sha256) fail("EVIDENCE", `task ${manifest.todo} evidence digest mismatch or empty artifact`);
  }
}

async function runPortableCore(phase, childArgv, ci, attemptDir) {
  const snapshot = snapshotGeneratedArtifacts();
  const interrupt = () => { for (const child of activeChildren) void stopOwnedChild(child); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (phase === "browser") return await runBrowserPhase(childArgv, ci, attemptDir);
    const { withOperationalPostgres } = await import("./operational-fomo-harness.mjs");
    const databaseResult = await withOperationalPostgres({
      operation: async ({ databaseUrl, directUrl }) => {
        const env = operationalEnvironment(databaseUrl, directUrl, ci);
        await runCommand(npxCommand(), ["prisma", "validate"], env);
        if (phase === "full") {
          const testEnv = { ...process.env, NODE_ENV: "test" };
          for (const key of ["DATABASE_URL", "DEPLOYMENT_SHA", "DIRECT_URL", "INTEGRATION_DATABASE_URL"]) {
            delete testEnv[key];
          }
          await runCommand(npmCommand(), ["test"], testEnv);
        }
        await runCommand(npxCommand(), ["prisma", "generate"], env);
        await runCommand(npxCommand(), ["prisma", "migrate", "deploy"], env);
        await runCommand(npxCommand(), ["tsx", "scripts/apply-online-admin-search-indexes.ts"], env);
        if (phase === "database") {
          await runDatabaseContractQaInChild(env);
          return { phase, status: "passed" };
        }
        if (phase === "discord") {
          await runDiscordPhase(env);
          return { phase, status: "passed" };
        }
        await runDatabaseContractQaInChild(env);
        await runCommand(npmCommand(), ["run", "test:integration"], {
          ...env,
          INTEGRATION_DATABASE_URL: await configureRuntimeIntegrationUrl(databaseUrl)
        });
        await runCommandWithTransientPrismaRetry(npmCommand(), ["run", "build"], env);
        await runCommandWithTransientPrismaRetry(npmCommand(), ["run", "vercel-build"], env);
        await runDiscordPhase(env);
        return { phase, status: "passed" };
      },
      preauthorized: process.env.OPERATIONAL_FOMO_ALLOW_LOOPBACK_TEST_DATABASE === "1",
      preauthorizedUrl: process.env.INTEGRATION_DATABASE_URL,
      timeoutMs: 120_000
    });
    if (phase !== "full") {
      process.stdout.write(`${JSON.stringify(databaseResult)}\n`);
      return databaseResult;
    }
    const browserResult = await runBrowserPhase(childArgv, ci, attemptDir);
    const fullResult = { ...databaseResult, browser: browserResult };
    process.stdout.write(`${JSON.stringify(fullResult)}\n`);
    return fullResult;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    snapshot.restore();
  }
}

async function runDiscordPhase(env) {
  const { allocateLoopbackPort } = await import("./operational-fomo-harness.mjs");
  const port = await allocateLoopbackPort();
  await runCommand(npmCommand(), ["run", "discord:smoke", "--", "--mode", "full", "--port", String(port)], env);
}

async function configureRuntimeIntegrationUrl(databaseUrl) {
  const password = randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]+$/u.test(password)) fail("CORE", "generated runtime password is not SQL-literal safe");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`ALTER ROLE info_room_runtime WITH LOGIN PASSWORD '${password}'`);
  } finally {
    await client.end();
  }
  return roleUrl(databaseUrl, "info_room_runtime", password);
}

async function runDatabaseContractQaInChild(env) {
  const verifierUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const source = `
    import { runDatabaseContractQa } from ${JSON.stringify(verifierUrl)};
    await runDatabaseContractQa(process.env.DATABASE_URL);
  `;
  await runCommand(process.execPath, ["--input-type=module", "--eval", source], env);
}

export async function runDatabaseContractQa(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.DIRECT_URL = databaseUrl;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const runtimePassword = randomBytes(24).toString("base64url");
  const executorPassword = randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]+$/u.test(runtimePassword) || !/^[A-Za-z0-9_-]+$/u.test(executorPassword)) {
    fail("CORE", "generated database role password is not SQL-literal safe");
  }
  await prisma.$executeRawUnsafe(`ALTER ROLE info_room_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  await prisma.$executeRawUnsafe(`ALTER ROLE info_room_activation_executor WITH LOGIN PASSWORD '${executorPassword}'`);
  const runtimePrisma = new PrismaClient({ datasources: { db: { url: roleUrl(databaseUrl, "info_room_runtime", runtimePassword) } } });
  const executorPrisma = new PrismaClient({ datasources: { db: { url: roleUrl(databaseUrl, "info_room_activation_executor", executorPassword) } } });
  try {
    await prisma.$transaction(async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe(`
        INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt")
        VALUES ('qa-user','QA','qa-1',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "Reservation" ("id","userId","date","studyPeriod","reason","createdAt","updatedAt")
        VALUES ('qa-reservation','qa-user','2026-08-12','EIGHTH','qa',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "DiscordInteractionJob" (
          "interactionId","reservationId","sourceApplicationId","sourceGuildId","sourceChannelId","sourceMessageId",
          "discordActorId","localActorId","renderedEpoch","intent","ipHash","commandDigest","updatedAt"
        ) VALUES ('qa-job','qa-reservation','qa-application','guild','channel','message','discord','qa-user',0,'ACCEPT','sha256:ip','sha256:command',CURRENT_TIMESTAMP)
      `);
      await transaction.$executeRawUnsafe(`
        INSERT INTO "DiscordInteractionReceipt" (
          "interactionId","reservationId","intent","discordActorId","localActorId","status",
          "terminalOutcome","terminalResult","updatedAt"
        ) VALUES
          ('qa-receipt-1','qa-reservation','ACCEPT','discord','qa-user','TERMINAL','ACCEPTED','{}',CURRENT_TIMESTAMP),
          ('qa-receipt-2','qa-reservation','CANCEL','discord','qa-user','TERMINAL','CANCELLED','{}',CURRENT_TIMESTAMP)
      `);
      const rows = await transaction.$queryRawUnsafe(`
        SELECT (SELECT count(*)::int FROM "DiscordInteractionReceipt" WHERE "reservationId"='qa-reservation') AS receipt_count,
               (SELECT "ipHash" FROM "DiscordInteractionJob" WHERE "interactionId"='qa-job') AS ip_hash
      `);
      const row = rows[0];
      if (row?.receipt_count !== 2 || row?.ip_hash !== "sha256:ip") fail("CORE", "receipt cardinality or ipHash durability failed");
    });

    const runtimeIdentity = await runtimePrisma.$queryRawUnsafe(`
      SELECT current_user AS "currentUser", session_user AS "sessionUser", rolsuper, rolbypassrls,
             pg_has_role(current_user, 'info_room_activation_owner', 'MEMBER') AS "activationOwnerMember"
      FROM pg_roles WHERE rolname = current_user
    `);
    const runtime = runtimeIdentity[0];
    if (runtime?.currentUser !== "info_room_runtime" || runtime?.sessionUser !== "info_room_runtime" ||
        runtime?.rolsuper !== false || runtime?.rolbypassrls !== false || runtime?.activationOwnerMember !== false) {
      fail("CORE", "database QA must use a real non-superuser, non-BYPASSRLS runtime session");
    }
    const functionOwners = await prisma.$queryRawUnsafe(`
      SELECT p.proname, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin,
             p.prosecdef, p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AS "fixedSearchPath"
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid IN (
        'app_private.record_application_readiness(text,text,text)'::regprocedure,
        'app_private.activate_application_contract(text,text,text)'::regprocedure
      ) ORDER BY p.proname
    `);
    if (functionOwners.length !== 2 || !functionOwners.every((row) =>
      row.rolname === "info_room_activation_owner" && row.rolsuper === false && row.rolbypassrls === false &&
      row.rolcanlogin === false && row.prosecdef === true && row.fixedSearchPath === true)) {
      fail("CORE", "readiness and activation functions require a dedicated non-superuser, non-BYPASSRLS owner");
    }
    const executorIdentity = await executorPrisma.$queryRawUnsafe(`
      SELECT current_user AS "currentUser", session_user AS "sessionUser", rolsuper, rolbypassrls,
             pg_has_role(current_user, 'info_room_activation_owner', 'MEMBER') AS "activationOwnerMember"
      FROM pg_roles WHERE rolname = current_user
    `);
    const executor = executorIdentity[0];
    if (executor?.currentUser !== "info_room_activation_executor" || executor?.sessionUser !== "info_room_activation_executor" ||
        executor?.rolsuper !== false || executor?.rolbypassrls !== false || executor?.activationOwnerMember !== false) {
      fail("CORE", "activation QA must use a dedicated non-superuser, non-BYPASSRLS executor session");
    }

    await expectDatabaseFailure(runtimePrisma, async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe(`UPDATE "SchemaCompatibility" SET "updatedAt"=CURRENT_TIMESTAMP`);
    }, "runtime marker write");
    await expectDatabaseFailure(runtimePrisma, async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$queryRawUnsafe(`SELECT app_private.record_application_readiness($1,$2,$3)`, DEPLOYMENT_SHA, READINESS_DIGEST, "ADMIN");
    }, "runtime readiness function execution");
    const receiptId = await executorPrisma.$transaction(async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      const rows = await transaction.$queryRawUnsafe(
        `SELECT app_private.record_application_readiness($1,$2,$3) AS id`,
        DEPLOYMENT_SHA,
        READINESS_DIGEST,
        "ADMIN"
      );
      return rows[0]?.id;
    });
    if (typeof receiptId !== "string") fail("CORE", "readiness receipt was not returned");
    await executorPrisma.$transaction(async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe("SELECT set_config('app.activation_source','ADMIN',true)");
      await transaction.$queryRawUnsafe(`SELECT app_private.activate_application_contract($1,$2,$3)::text`, DEPLOYMENT_SHA, receiptId, "ADMIN");
    });
    await expectDatabaseFailure(executorPrisma, async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe("SELECT set_config('app.activation_source','ADMIN',true)");
      await transaction.$queryRawUnsafe(`SELECT app_private.activate_application_contract($1,$2,$3)::text`, DEPLOYMENT_SHA, receiptId, "ADMIN");
    }, "one-use receipt replay");
    const marker = await prisma.$transaction(async (transaction) => {
      await setOperationalContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      return transaction.$queryRawUnsafe(`
        SELECT s."activationReceiptId", s."deploymentSha", r."consumedAt"
        FROM "SchemaCompatibility" s JOIN "ApplicationDeploymentReceipt" r ON r."id"=s."activationReceiptId"
      `);
    });
    if (marker[0]?.activationReceiptId !== receiptId || marker[0]?.deploymentSha !== DEPLOYMENT_SHA || marker[0]?.consumedAt === null) {
      fail("CORE", "activation receipt was not consumed exactly once and linked");
    }
    process.stdout.write("databaseContractQa=passed\n");
  } finally {
    await executorPrisma.$disconnect();
    await runtimePrisma.$disconnect();
    await prisma.$disconnect();
  }
}

function roleUrl(databaseUrl, username, password) {
  const url = new URL(databaseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

async function setOperationalContext(transaction, contract, sha, role) {
  await transaction.$executeRawUnsafe("SELECT set_config('app.current_user_role',$1,true)", role);
  await transaction.$executeRawUnsafe("SELECT set_config('app.application_contract',$1,true)", contract);
  await transaction.$executeRawUnsafe("SELECT set_config('app.deployment_sha',$1,true)", sha);
}

async function expectDatabaseFailure(prisma, operation, label) {
  let failed = false;
  try {
    await prisma.$transaction(operation);
  } catch {
    failed = true;
  }
  if (!failed) fail("CORE", `${label} unexpectedly succeeded`);
}

async function runBrowserPhase(childArgv, ci, attemptDir) {
  const { allocateLoopbackPort } = await import("./operational-fomo-harness.mjs");
  const port = await allocateLoopbackPort();
  const evidenceRoot = resolveBrowserEvidenceRoot(attemptDir);
  const env = browserEnvironment(port, ci, evidenceRoot.path);
  const invocation = executableInvocation(npmCommand(), ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", String(port)]);
  const server = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(), detached: process.platform !== "win32", env, shell: false,
    stdio: ["ignore", "inherit", "inherit"], windowsHide: true
  });
  activeChildren.add(server);
  try {
    await waitForHealth(port, server);
    if (childArgv.length > 0) await runCommand(childArgv[0], childArgv.slice(1), env);
    else await runCommand(npxCommand(), ["playwright", "test", ...focusedSpecs(), "--workers=1"], env);
  } finally {
    await stopOwnedChild(server);
    activeChildren.delete(server);
    const portStillListening = await portHasListener(port);
    if (evidenceRoot.owned) rmSync(evidenceRoot.path, { force: true, recursive: true });
    if (portStillListening) fail("CLEANUP", `browser port remains in use: ${port}`);
  }
  return {
    evidenceDir: evidenceRoot.owned ? "temporary-cleaned" : evidenceRoot.path,
    phase: "browser",
    status: "passed"
  };
}

function resolveBrowserEvidenceRoot(attemptDir) {
  const configured = process.env.EVIDENCE_DIR?.trim();
  if (configured && configured.length > 0) {
    const evidenceRoot = resolve(configured);
    mkdirSync(evidenceRoot, { recursive: true });
    return { owned: false, path: evidenceRoot };
  }
  const evidenceRoot = attemptDir === undefined
    ? mkdtempSync(join(tmpdir(), "operational-fomo-browser-evidence-"))
    : resolve(attemptDir, "browser-evidence");
  if (attemptDir !== undefined) rmSync(evidenceRoot, { force: true, recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  return { owned: attemptDir === undefined, path: evidenceRoot };
}

function operationalEnvironment(databaseUrl, directUrl, ci) {
  return {
    ...process.env, ADMIN_STUDENT_NUMBERS: "99999", APP_ORIGIN: "https://example.test",
    CI: ci ? "true" : process.env.CI, CLOSED_PERIOD_CRON_SECRET: "qa-closed-period-cron-secret-long-enough",
    DATABASE_URL: databaseUrl, DEPLOYMENT_SHA: "b".repeat(40), DIRECT_URL: directUrl,
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/qa-token",
    ENABLE_LOCAL_ADMIN: "false", ENABLE_LOCAL_STUDENT: "false",
    INTEGRATION_DATABASE_URL: databaseUrl, MAINTENANCE_CRON_SECRET: "qa-maintenance-cron-secret-long-enough",
    NODE_ENV: "production", OBSERVABILITY_PROJECT_ID: "qa-project", OBSERVABILITY_PROVIDER: "qa-provider",
    OPERATIONS_ALERT_DESTINATION: "qa-alerts", OPERATIONS_ESCALATION_PATH: "qa-owner-then-platform",
    OPERATIONS_OWNER: "qa-owner", RETENTION_PURGE_ENABLED: "false", RIRO_MOCK_LOGIN: "false",
    SESSION_SECRET: "qa-session-secret-that-is-long-and-isolated", TRUST_FORWARDED_IP_HEADERS: "true"
  };
}

function browserEnvironment(port, ci, evidenceRoot) {
  return {
    ...process.env, ADMIN_LOGIN_ID: "ci-admin", ADMIN_LOGIN_PASSWORD: "ci-admin-password",
    CI: ci ? "true" : process.env.CI, DATABASE_URL: "", DIRECT_URL: "",
    E2E_ADMIN_LOGIN_ID: "ci-admin", E2E_ADMIN_LOGIN_PASSWORD: "ci-admin-password",
    E2E_BASE_URL: `http://127.0.0.1:${port}`, E2E_STUDENT_LOGIN_ID: "ci-student",
    E2E_STUDENT_LOGIN_PASSWORD: "ci-student-password", ENABLE_LOCAL_ADMIN: "true",
    ENABLE_LOCAL_STUDENT: "true", LOCAL_STUDENT_LOGIN_ID: "ci-student",
    LOCAL_STUDENT_LOGIN_PASSWORD: "ci-student-password", LOCAL_STUDENT_NAME: "CI 학생",
    LOCAL_STUDENT_NUMBER: "32001", NODE_ENV: "development", RIRO_MOCK_LOGIN: "true", EVIDENCE_DIR: evidenceRoot,
    TRUST_FORWARDED_IP_HEADERS: "true"
  };
}

async function runCommand(command, args, env) {
  const invocation = executableInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(), detached: process.platform !== "win32", env, shell: false,
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = appendOutputTail(stdout, chunk.toString());
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendOutputTail(stderr, chunk.toString());
    process.stderr.write(chunk);
  });
  activeChildren.add(child);
  const terminal = new Promise((complete) => {
    child.once("error", (error) => complete({ kind: "error", error }));
    child.once("close", (status) => complete({ kind: "close", status: status ?? -1 }));
  });
  let timer;
  try {
    const result = await Promise.race([
      terminal,
      new Promise((complete) => { timer = setTimeout(() => complete({ kind: "timeout" }), 900_000); })
    ]);
    if (result.kind === "timeout") {
      await stopOwnedChild(child);
      fail("CORE", `${command} ${args.join(" ")} timed out`);
    }
    if (result.kind === "error") throw new OperationalEvidenceError("CORE", `${command} failed to execute`, { cause: result.error });
    if (result.status !== 0) {
      throw new OperationalEvidenceError("CORE", `${command} ${args.join(" ")} exited ${result.status}`, {
        cause: new Error(`${stdout}\n${stderr}`)
      });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    activeChildren.delete(child);
  }
}

async function runCommandWithTransientPrismaRetry(command, args, env) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runCommand(command, args, env);
    } catch (error) {
      if (attempt >= 4 || !isTransientWindowsPrismaLock(error)) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 5_000));
    }
  }
}

function isTransientWindowsPrismaLock(error) {
  if (process.platform !== "win32" || !(error instanceof OperationalEvidenceError) || !(error.cause instanceof Error)) {
    return false;
  }
  return /(?:EPERM|EBUSY)[\s\S]*query_engine-windows\.dll\.node/iu.test(error.cause.message);
}

function appendOutputTail(current, chunk) {
  return `${current}${chunk}`.slice(-32_768);
}

function snapshotGeneratedArtifacts() {
  const root = mkdtempSync(join(tmpdir(), "operational-fomo-artifacts-"));
  const paths = [".next", "test-results", "tsconfig.tsbuildinfo", "next-env.d.ts"];
  const present = new Set(paths.filter((path) => existsSync(resolve(path))));
  for (const path of present) copyArtifact(resolve(path), join(root, basename(path)));
  return { restore() {
    for (const path of paths) rmSync(resolve(path), { force: true, recursive: true });
    for (const path of present) copyArtifact(join(root, basename(path)), resolve(path));
    rmSync(root, { force: true, recursive: true });
  } };
}

function copyArtifact(source, destination) {
  const metadata = lstatSync(source);
  if (metadata.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyArtifact(join(source, entry), join(destination, entry));
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  if (metadata.isFile()) {
    copyFileSync(source, destination);
    return;
  }
  if (metadata.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination, statSync(source).isDirectory() ? "dir" : "file");
    return;
  }
  fail("CORE", `unsupported generated artifact type: ${source}`);
}

function waitForHealth(port, server) {
  return new Promise((resolveReady, rejectReady) => {
    let attempts = 0;
    const poll = () => {
      if (server.exitCode !== null) { rejectReady(new OperationalEvidenceError("BROWSER", `server exited ${server.exitCode}`)); return; }
      const request = get(`http://127.0.0.1:${port}/api/health/live`, (response) => {
        response.resume();
        if ((response.statusCode ?? 500) < 400) { resolveReady(); return; }
        retry();
      });
      request.once("error", retry);
    };
    const retry = () => { attempts += 1; if (attempts >= 120) rejectReady(new OperationalEvidenceError("BROWSER", "server readiness timed out")); else setTimeout(poll, 250); };
    poll();
  });
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore", windowsHide: true });
  else { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error; } }
  await new Promise((resolveExit) => { const timeout = setTimeout(resolveExit, 5_000); child.once("exit", () => { clearTimeout(timeout); resolveExit(); }); });
}

function focusedSpecs() {
  return [
    "tests/home-realtime-refresh.spec.ts", "tests/home-refresh-recovery.spec.ts",
    "tests/student-current-reservations.spec.ts", "tests/home-keyboard-accessibility.spec.ts",
    "tests/home-ui-density.spec.ts", "tests/admin-operations-command-center.spec.ts",
    "tests/admin-pagination-export.spec.ts", "tests/admin-bulk-cancellation.spec.ts"
  ];
}

function npmCommand() { return process.platform === "win32" ? "npm.cmd" : "npm"; }
function npxCommand() { return process.platform === "win32" ? "npx.cmd" : "npx"; }
function executableInvocation(command, args) {
  if (process.platform !== "win32" || !["npm", "npm.cmd", "npx", "npx.cmd"].includes(command)) {
    return { command, args };
  }
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", command.startsWith("npm") ? "npm-cli.js" : "npx-cli.js");
  return { command: process.execPath, args: [cli, ...args] };
}

function parseDependencies(planText) {
  const section = sectionText(planText, "### Dependency matrix", "### Task-owned write sets");
  const output = new Map();
  for (const match of section.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+)\|/gmu)) {
    const todo = Number(match[1]);
    const raw = match[2].trim();
    output.set(todo, raw === "none" ? [] : expandNumbers(raw));
  }
  return output;
}

function parseWriteSets(planText) {
  const section = sectionText(planText, "### Task-owned write sets", "## Todos", true);
  const output = new Map();
  for (const match of section.matchAll(/^\|\s*(\d+)\s*\|\s*((?:`[^`]+`;?\s*)+)\|$/gmu)) {
    output.set(Number(match[1]), [...match[2].matchAll(/`([^`]+)`/gu)].map((item) => item[1]));
  }
  return output;
}

function parallelWriteSetIntersections(dependencies, writeSets) {
  const intersections = [];
  for (let left = 1; left <= TODO_COUNT; left += 1) {
    for (let right = left + 1; right <= TODO_COUNT; right += 1) {
      if (dependsOn(dependencies, left, right) || dependsOn(dependencies, right, left)) continue;
      const shared = (writeSets.get(left) ?? []).filter((path) => (writeSets.get(right) ?? []).includes(path));
      if (shared.length > 0) intersections.push(`${left}/${right}:${shared.join("+")}`);
    }
  }
  return intersections;
}

function dependsOn(dependencies, todo, candidate, seen = new Set()) {
  if (seen.has(todo)) return false;
  seen.add(todo);
  const direct = dependencies.get(todo) ?? [];
  return direct.includes(candidate) || direct.some((dependency) => dependsOn(dependencies, dependency, candidate, seen));
}

function verifyDescriptor(descriptor, label) {
  verifyFileIdentity({ path: descriptor.target.path, sha256: descriptor.target.sha256,
    volume: descriptor.target.volume, fileIndex: descriptor.target.fileIndex }, label);
}

function verifyFileIdentity(identity, label) {
  if (!existsSync(identity.path) || !lstatSync(identity.path).isFile() || lstatSync(identity.path).isSymbolicLink()) {
    fail("IDENTITY", `attempt identity ${label} is missing, linked, or not a file`);
  }
  const metadata = statSync(identity.path, { bigint: true });
  if (!identityEquals(metadata.dev, identity.volume) || !identityEquals(metadata.ino, identity.fileIndex) ||
      sha256File(identity.path) !== identity.sha256) {
    fail("IDENTITY", `attempt identity ${label} changed`);
  }
}

function parseReviewReceipt(text) {
  const launches = [...text.matchAll(/^\s+launch_id:\s*(\S+)$/gmu)].map((match) => match[1]);
  const sessions = [...text.matchAll(/^\s+session:\s*(\S+)$/gmu)].map((match) => match[1]);
  return {
    roundId: receiptField(text, "review_round_id"), status: receiptField(text, "status"),
    roundStatus: receiptField(text, "round_status"), planPath: receiptField(text, "plan_path"),
    planSha256: receiptField(text, "plan_sha256"), momusLaunchId: launches[0], momusSessionId: sessions[0],
    independentLaunchId: launches[1], independentSessionId: sessions[1],
    momusReviewedHeadSha: receiptField(text, "momusReviewedHeadSha"),
    momusReviewedTreeSha: receiptField(text, "momusReviewedTreeSha"),
    momusReviewedClean: receiptField(text, "momusReviewedClean") === "true",
    independentReviewedHeadSha: receiptField(text, "independentReviewedHeadSha"),
    independentReviewedTreeSha: receiptField(text, "independentReviewedTreeSha"),
    independentReviewedClean: receiptField(text, "independentReviewedClean") === "true",
    executionBaseSha: receiptField(text, "executionBaseSha"), executionBaseTreeSha: receiptField(text, "executionBaseTreeSha")
  };
}

function evidencePath(attemptDir, raw, label) {
  const path = resolve(raw);
  const inside = relative(realpathSync(attemptDir), realpathSync(path));
  if (inside.startsWith("..") || isAbsolute(inside) || !statSync(path).isFile()) fail("EVIDENCE", `${label} escapes attempt directory`);
  return path;
}

function portHasListener(port) {
  return new Promise((complete) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (value) => { socket.destroy(); complete(value); };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", shell: false, timeout: 30_000, windowsHide: true });
  if (result.error !== undefined) throw new OperationalEvidenceError("GIT", "Git proof failed to execute", { cause: result.error });
  if (result.status !== 0) fail("GIT", (result.stderr ?? "").trim() || `git ${args.join(" ")} failed`);
  return (result.stdout ?? "").trim();
}

function gitHistory(cwd, head) {
  const text = git(cwd, ["log", "--format=@@@%H|%T|%P", "--name-only", head]);
  const history = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("@@@")) {
      const [commit, tree, parentText = ""] = line.slice(3).split("|");
      if (commit === undefined || tree === undefined) fail("GIT", "malformed Git history proof");
      current = { tree, parents: parentText.length === 0 ? [] : parentText.split(" "), changedPaths: [] };
      history.set(commit, current);
    } else if (line.length > 0 && current !== null) {
      current.changedPaths.push(line);
    }
  }
  return history;
}

function isHistoryAncestor(history, ancestor, descendant) {
  const pending = [descendant];
  const seen = new Set();
  while (pending.length > 0) {
    const commit = pending.pop();
    if (commit === ancestor) return true;
    if (commit === undefined || seen.has(commit)) continue;
    seen.add(commit);
    const node = history.get(commit);
    if (node !== undefined) pending.push(...node.parents);
  }
  return false;
}

function parseFile(path, schema, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail("EVIDENCE", `${label} is missing`);
  const parsed = schema.safeParse(readJson(path, label));
  if (!parsed.success) fail("SCHEMA", `${label} is invalid: ${formatIssues(parsed.error)}`);
  return parsed.data;
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new OperationalEvidenceError("JSON", `${label} is not valid JSON`, { cause: error }); }
}

function sectionText(text, start, end, allowEndOfFile = false) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || (endIndex < 0 && !allowEndOfFile)) fail("PLAN", `missing plan section ${start}`);
  return text.slice(startIndex, endIndex < 0 ? text.length : endIndex);
}

function expandNumbers(raw) {
  const output = [];
  for (const part of raw.split(",").map((value) => value.trim())) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range === null) output.push(Number(part));
    else for (let value = Number(range[1]); value <= Number(range[2]); value += 1) output.push(value);
  }
  if (output.some((value) => !Number.isInteger(value) || value < 1 || value > TODO_COUNT)) fail("PLAN", `invalid dependency list ${raw}`);
  return output;
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -3)) : path === pattern);
}

function equalSets(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function lines(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}

function identityEquals(actual, expected) { return typeof expected === "number" ? Number(actual) === expected : actual.toString() === expected; }
function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function formatIssues(error) { return error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; "); }
function receiptField(text, name) {
  const match = new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(text);
  if (match?.[1] === undefined) fail("IDENTITY", `attempt identity review field missing: ${name}`);
  return match[1].trim();
}
function assertNever(value) { fail("ARGUMENT", `invalid arguments: unsupported mode ${String(value)}`); }
function fail(code, message) { throw new OperationalEvidenceError(code, message); }

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  execute(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    const code = error instanceof OperationalEvidenceError ? error.code : "UNKNOWN";
    process.stderr.write(`Operational evidence verification failed [${code}]: ${message}\n`);
    process.exitCode = 1;
  });
}
