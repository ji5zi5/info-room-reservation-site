// allow: SIZE_OK — one auditable operational verifier keeps CLI gates and their PostgreSQL contract matrix together.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { OperationalHarnessError, withOperationalPostgres } from "./operational-fomo-harness.mjs";

const PHASES = ["database", "browser", "discord", "full"];
const READINESS_DIGEST = "c99eebbeec6b76f35bce411575d3f03614703fa528d27964cce6989b5356e2b4";
const DEPLOYMENT_SHA = "90386d9f77c9c9c665754966d2535a8276a5a547";

export class OperationalChildError extends Error {
  constructor(message, details, options = {}) {
    super(message, options);
    this.name = "OperationalChildError";
    this.details = details;
  }
}

export class OperationalPrerequisiteError extends Error {
  constructor(phase, message) {
    super(message);
    this.name = "OperationalPrerequisiteError";
    this.phase = phase;
  }
}

export function parseCoreArguments(argv) {
  const phaseIndex = argv.indexOf("--phase");
  const phase = phaseIndex >= 0 ? argv[phaseIndex + 1] : undefined;
  return z.object({ phase: z.enum(PHASES) }).parse({ phase });
}

export async function runChildCommand(command, args, options = {}) {
  const startedAt = new Date().toISOString();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(), env: { ...process.env, ...options.env }, shell: false,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    let settled = false;
    const timeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await terminateProcessTree(child.pid);
      rejectRun(new OperationalChildError("child command timed out", { args, command, startedAt, stderr, stdout }));
    }, options.timeoutMs ?? 120_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRun(new OperationalChildError("child command failed to start", { args, command, startedAt }, { cause: error }));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const details = { args, command, exitCode, finishedAt: new Date().toISOString(), startedAt, stderr, stdout };
      if (exitCode !== 0) {
        rejectRun(new OperationalChildError("child command exited unsuccessfully", details));
        return;
      }
      resolveRun(details);
    });
  });
}

export async function runOperationalCore(options) {
  const phase = z.enum(PHASES).parse(options.phase);
  if (phase === "browser") {
    await requireChromium();
    throw new OperationalPrerequisiteError(phase, "browser phase gates are introduced by later approved todos");
  }
  if (phase === "discord") {
    throw new OperationalPrerequisiteError(phase, "Discord phase gates are introduced by later approved todos");
  }

  const preauthorizedUrl = process.env.INTEGRATION_DATABASE_URL;
  return withOperationalPostgres({
    attemptDir: options.attemptDir,
    operation: async ({ databaseUrl, directUrl, receipt }) => {
      const env = { DATABASE_URL: databaseUrl, DIRECT_URL: directUrl, INTEGRATION_DATABASE_URL: databaseUrl };
      const commands = [];
      for (const args of [["prisma", "validate"], ["prisma", "generate"], ["prisma", "migrate", "deploy"]]) {
        commands.push(await runChildCommand(process.execPath, [prismaCliPath(), ...args.slice(1)], { env }));
      }
      await runDatabaseContractQa(databaseUrl);
      if (phase === "full") {
        commands.push(await runChildCommand(process.execPath, [resolve("scripts", "typecheck.mjs")], { env }));
        throw new OperationalPrerequisiteError(phase, "full phase awaits later Discord and browser gates");
      }
      const result = { commands: commands.map(({ command, args, exitCode }) => ({ command, args, exitCode })), phase, receipt, status: "passed" };
      if (options.attemptDir !== undefined) {
        await writeFile(resolve(options.attemptDir, "task-1-operational-fomo-upgrade.txt"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
      }
      return result;
    },
    preauthorized: process.env.OPERATIONAL_FOMO_ALLOW_LOOPBACK_TEST_DATABASE === "1",
    preauthorizedUrl,
    timeoutMs: options.timeoutMs
  });
}

async function terminateProcessTree(pid) {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise((resolveTermination) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { shell: false, windowsHide: true, stdio: "ignore" });
      const deadline = setTimeout(() => { killer.kill(); resolveTermination(); }, 5_000);
      killer.once("close", () => { clearTimeout(deadline); resolveTermination(); });
      killer.once("error", () => { clearTimeout(deadline); resolveTermination(); });
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function runDatabaseContractQa(databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
  process.env.DIRECT_URL = databaseUrl;
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const runtimePassword = randomBytes(24).toString("base64url");
  const executorPassword = randomBytes(24).toString("base64url");
  assert(/^[A-Za-z0-9_-]+$/u.test(runtimePassword), "generated runtime password is not SQL-literal safe");
  assert(/^[A-Za-z0-9_-]+$/u.test(executorPassword), "generated executor password is not SQL-literal safe");
  await prisma.$executeRawUnsafe(`ALTER ROLE info_room_runtime WITH LOGIN PASSWORD '${runtimePassword}'`);
  await prisma.$executeRawUnsafe(`ALTER ROLE info_room_activation_executor WITH LOGIN PASSWORD '${executorPassword}'`);
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = "info_room_runtime";
  runtimeUrl.password = runtimePassword;
  const runtimePrisma = new PrismaClient({ datasources: { db: { url: runtimeUrl.toString() } } });
  const executorUrl = new URL(databaseUrl);
  executorUrl.username = "info_room_activation_executor";
  executorUrl.password = executorPassword;
  const executorPrisma = new PrismaClient({ datasources: { db: { url: executorUrl.toString() } } });
  try {
    await prisma.$transaction(async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
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
          "interactionId","reservationId","sourceGuildId","sourceChannelId","sourceMessageId",
          "discordActorId","localActorId","renderedEpoch","intent","ipHash","commandDigest","updatedAt"
        ) VALUES ('qa-job','qa-reservation','guild','channel','message','discord','qa-user',0,'ACCEPT','sha256:ip','sha256:command',CURRENT_TIMESTAMP)
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
      assert(row?.receipt_count === 2 && row?.ip_hash === "sha256:ip", "receipt cardinality or ipHash durability failed");
    });

    const runtimeIdentity = await runtimePrisma.$queryRawUnsafe(`
      SELECT current_user AS "currentUser", session_user AS "sessionUser", rolsuper, rolbypassrls,
             pg_has_role(current_user, 'info_room_activation_owner', 'MEMBER') AS "activationOwnerMember"
      FROM pg_roles WHERE rolname = current_user
    `);
    assert(runtimeIdentity[0]?.currentUser === "info_room_runtime" && runtimeIdentity[0]?.sessionUser === "info_room_runtime" &&
      runtimeIdentity[0]?.rolsuper === false && runtimeIdentity[0]?.rolbypassrls === false &&
      runtimeIdentity[0]?.activationOwnerMember === false,
    "database QA must use a real non-superuser, non-BYPASSRLS runtime session");
    const functionOwners = await prisma.$queryRawUnsafe(`
      SELECT p.proname, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcanlogin,
             p.prosecdef, p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'] AS "fixedSearchPath"
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.oid IN (
        'app_private.record_application_readiness(text,text,text)'::regprocedure,
        'app_private.activate_application_contract(text,text,text)'::regprocedure
      ) ORDER BY p.proname
    `);
    assert(functionOwners.length === 2 && functionOwners.every((row) =>
      row.rolname === "info_room_activation_owner" && row.rolsuper === false && row.rolbypassrls === false &&
      row.rolcanlogin === false && row.prosecdef === true && row.fixedSearchPath === true),
    "readiness and activation functions require a dedicated non-superuser, non-BYPASSRLS owner");
    const executorIdentity = await executorPrisma.$queryRawUnsafe(`
      SELECT current_user AS "currentUser", session_user AS "sessionUser", rolsuper, rolbypassrls,
             pg_has_role(current_user, 'info_room_activation_owner', 'MEMBER') AS "activationOwnerMember"
      FROM pg_roles WHERE rolname = current_user
    `);
    assert(executorIdentity[0]?.currentUser === "info_room_activation_executor" &&
      executorIdentity[0]?.sessionUser === "info_room_activation_executor" && executorIdentity[0]?.rolsuper === false &&
      executorIdentity[0]?.rolbypassrls === false && executorIdentity[0]?.activationOwnerMember === false,
    "activation QA must use a dedicated non-superuser, non-BYPASSRLS executor session");

    await expectDatabaseFailure(runtimePrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe(`UPDATE "SchemaCompatibility" SET "updatedAt"=CURRENT_TIMESTAMP`);
    }, "runtime marker write");
    await expectDatabaseFailure(runtimePrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe(`
        INSERT INTO "ApplicationDeploymentReceipt" (
          "id", "deploymentSha", "schemaContract", "applicationContract", "readinessDigest",
          "activationSource", "verifiedAt", "expiresAt"
        ) VALUES ('direct-runtime-receipt',$1,'discord-ops-v2','discord-ops-v2',$2,'ADMIN',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + interval '10 minutes')
      `, DEPLOYMENT_SHA, READINESS_DIGEST);
    }, "runtime receipt write");
    await expectDatabaseFailure(runtimePrisma, async (transaction) => {
      await transaction.$executeRawUnsafe(`INSERT INTO app_private.online_schema_migrations VALUES ('qa','x','APPLYING',CURRENT_TIMESTAMP,NULL,NULL)`);
    }, "runtime online migration ledger write");
    await expectDatabaseFailure(runtimePrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$queryRawUnsafe(`SELECT app_private.record_application_readiness($1,$2,$3)`, DEPLOYMENT_SHA, READINESS_DIGEST, "ADMIN");
    }, "runtime readiness function execution");
    await expectDatabaseFailure(executorPrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v1", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$queryRawUnsafe(`SELECT app_private.record_application_readiness($1,$2,$3)`, DEPLOYMENT_SHA, READINESS_DIGEST, "ADMIN");
    }, "wrong readiness contract");
    await expectDatabaseFailure(executorPrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$queryRawUnsafe(`SELECT app_private.record_application_readiness($1,$2,$3)`, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", READINESS_DIGEST, "ADMIN");
    }, "wrong readiness deployment SHA");
    await expectDatabaseFailure(executorPrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$queryRawUnsafe(`SELECT app_private.record_application_readiness($1,$2,$3)`, DEPLOYMENT_SHA, "wrong-digest", "ADMIN");
    }, "wrong readiness digest");

    const createReceipt = async (sha = DEPLOYMENT_SHA, source = "ADMIN") => executorPrisma.$transaction(async (transaction) => {
      await setContext(transaction, "discord-ops-v2", sha, "SYSTEM");
      const rows = await transaction.$queryRawUnsafe(
        `SELECT app_private.record_application_readiness($1,$2,$3) AS id`, sha, READINESS_DIGEST, source
      );
      return rows[0]?.id;
    });
    const activateReceipt = async (receipt, sha = DEPLOYMENT_SHA, settingSource = "ADMIN", expectedSource = "ADMIN") =>
      executorPrisma.$transaction(async (transaction) => {
        await setContext(transaction, "discord-ops-v2", sha, "SYSTEM");
        await transaction.$executeRawUnsafe("SELECT set_config('app.activation_source',$1,true)", settingSource);
        await transaction.$queryRawUnsafe(
          `SELECT app_private.activate_application_contract($1,$2,$3)::text`, sha, receipt, expectedSource
        );
      });

    const expiredReceipt = await createReceipt();
    await prisma.$executeRawUnsafe(`UPDATE "ApplicationDeploymentReceipt" SET "expiresAt"=CURRENT_TIMESTAMP - interval '1 second' WHERE "id"=$1`, expiredReceipt);
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(expiredReceipt), "expired receipt");

    const consumedReceipt = await createReceipt();
    await prisma.$executeRawUnsafe(`UPDATE "ApplicationDeploymentReceipt" SET "consumedAt"=CURRENT_TIMESTAMP WHERE "id"=$1`, consumedReceipt);
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(consumedReceipt), "consumed receipt replay");

    const crossShaReceipt = await createReceipt("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(crossShaReceipt), "cross-SHA receipt");

    const firstCronReceipt = await createReceipt(DEPLOYMENT_SHA, "FIRST_CRON");
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(firstCronReceipt), "receipt source mismatch");

    const settingMismatchReceipt = await createReceipt();
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(settingMismatchReceipt, DEPLOYMENT_SHA, "FIRST_CRON", "ADMIN"), "setting source mismatch");

    const wrongExpectedReceipt = await createReceipt();
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(wrongExpectedReceipt, DEPLOYMENT_SHA, "ADMIN", "FIRST_CRON"), "wrong expected source");

    const receiptId = await createReceipt();
    assert(typeof receiptId === "string", "readiness receipt was not returned");
    await expectDatabaseFailure(executorPrisma, async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe("SELECT set_config('app.activation_source','FIRST_CRON',true)");
      await transaction.$queryRawUnsafe(`SELECT app_private.activate_application_contract($1,$2,$3)::text`, DEPLOYMENT_SHA, receiptId, "ADMIN");
    }, "activation source mismatch");

    await prisma.$executeRawUnsafe(`UPDATE "DiscordReservationMessage" SET "legacyControlState"='CURRENT' WHERE true`);
    await executorPrisma.$transaction(async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      await transaction.$executeRawUnsafe("SELECT set_config('app.activation_source','ADMIN',true)");
      await transaction.$queryRawUnsafe(`SELECT app_private.activate_application_contract($1,$2,$3)::text`, DEPLOYMENT_SHA, receiptId, "ADMIN");
    });
    await expectDatabaseFailure(executorPrisma, () => activateReceipt(receiptId), "one-use receipt replay");
    const marker = await prisma.$transaction(async (transaction) => {
      await setContext(transaction, "discord-ops-v2", DEPLOYMENT_SHA, "SYSTEM");
      return transaction.$queryRawUnsafe(`
        SELECT s."activationReceiptId", s."deploymentSha", r."consumedAt"
        FROM "SchemaCompatibility" s JOIN "ApplicationDeploymentReceipt" r ON r."id"=s."activationReceiptId"
      `);
    });
    assert(marker[0]?.activationReceiptId === receiptId && marker[0]?.deploymentSha === DEPLOYMENT_SHA && marker[0]?.consumedAt !== null,
      "activation receipt was not consumed exactly once and linked");
  } finally {
    await executorPrisma.$disconnect();
    await runtimePrisma.$disconnect();
    await prisma.$disconnect();
  }
}

async function setContext(transaction, contract, sha, role) {
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
  assert(failed, `${label} unexpectedly succeeded`);
}

function assert(condition, message) {
  if (!condition) throw new OperationalChildError(message, { condition });
}

export async function requireChromium(run = runChildCommand, cliPath = resolve("node_modules", "playwright", "cli.js")) {
  try {
    await run(process.execPath, [cliPath, "install", "--dry-run", "chromium"], { timeoutMs: 30_000 });
  } catch (error) {
    throw new OperationalHarnessError("chromium", "Playwright Chromium is unavailable", { cause: error });
  }
}

function prismaCliPath() {
  return fileURLToPath(import.meta.resolve("prisma/build/index.js"));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { phase } = parseCoreArguments(process.argv.slice(2));
  runOperationalCore({ phase }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
