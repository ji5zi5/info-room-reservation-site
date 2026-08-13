// allow: SIZE_OK — static protocol guards and the complete catalog mismatch matrix stay auditable together.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ONLINE_INDEX_CHECKSUM,
  ONLINE_INDEX_MANIFEST,
  ONLINE_INDEX_SESSION_COMMANDS,
  OnlineIndexError,
  applyOnlineAdminSearchIndexes,
  catalogDefinitionMatchesManifest
} from "./apply-online-admin-search-indexes";

const runnerSource = readFileSync(resolve("scripts/apply-online-admin-search-indexes.ts"), "utf8");
const EXACT_BASE_WRITER_SOURCE = String.raw`
  import { spawnSync } from "node:child_process";
  import { PrismaClient } from "@prisma/client";

  async function main() {
    const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
    if (commit.status !== 0) throw new Error(commit.stderr || commit.stdout);
    const prisma = new PrismaClient();
    let stopping = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { if (chunk.includes("STOP")) stopping = true; });
    const errors = [];
    let successfulWrites = 0;
    let transientRetries = 0;
    process.stdout.write("READY " + commit.stdout.trim() + "\n");
    while (!stopping) {
      const userNumber = successfulWrites % 5000 + 1;
      const cycle = Math.floor(successfulWrites / 10000);
      const studyPeriod = Math.floor(successfulWrites / 5000) % 2 === 0 ? "EIGHTH" : "FIRST";
      try {
        const reservation = await prisma.$transaction(async (transaction) => {
          await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
          return transaction.reservation.create({
            data: {
              date: "writer-date-" + cycle,
              reason: "rollout",
              status: "CONFIRMED",
              studyPeriod,
              userId: "writer-user-" + userNumber
            }
          });
        });
        if (reservation.userId !== "writer-user-" + userNumber) throw new Error("exact-base writer returned wrong user");
        successfulWrites += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/canceling statement due to lock timeout|deadlock detected|could not serialize access|P2034/u.test(message)) {
          transientRetries += 1;
          await new Promise((resolveWait) => setTimeout(resolveWait, 5));
          continue;
        }
        errors.push(message);
        stopping = true;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    process.stdin.pause();
    await prisma.$disconnect();
    process.stdout.write(JSON.stringify({
      commitSha: commit.stdout.trim(),
      successfulWrites,
      transientRetries,
      writerErrors: errors
    }) + "\n");
  }
  main().catch((error) => { console.error(error); process.exitCode = 1; });
`;

describe("online admin search index runner", () => {
  it("pins seven named structural definitions and a deterministic checksum", () => {
    // Given: the tracked structural manifest.
    const names = ONLINE_INDEX_MANIFEST.map(({ name }) => name);

    // When: its immutable identity is inspected.
    const checksum = ONLINE_INDEX_CHECKSUM;

    // Then: exactly the approved targets and SHA-256 identity are present.
    expect(names).toEqual([
      "User_name_trgm_idx",
      "User_studentNumber_trgm_idx",
      "AdminAction_action_trgm_idx",
      "AdminAction_reason_trgm_idx",
      "User_createdAt_id_idx",
      "Reservation_date_studyPeriod_createdAt_id_idx",
      "AdminAction_createdAt_id_idx"
    ]);
    expect(checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set(names).size).toBe(7);
  });

  it("keeps each concurrent DDL and timeout as one separate protocol command", () => {
    // Given: session commands and structural DDL strings.
    const commands = [...ONLINE_INDEX_SESSION_COMMANDS, ...ONLINE_INDEX_MANIFEST.map(({ createSql }) => createSql)];

    // When: commands are checked independently.
    const multiStatement = commands.filter((command) => command.includes(";") || /\bBEGIN\b/iu.test(command));

    // Then: no command contains a transaction or a second SQL statement.
    expect(ONLINE_INDEX_SESSION_COMMANDS).toEqual([
      "SET lock_timeout='2s'",
      "SET statement_timeout='5min'",
      "CREATE EXTENSION IF NOT EXISTS pg_trgm"
    ]);
    expect(multiStatement).toEqual([]);
    expect(ONLINE_INDEX_MANIFEST.every(({ createSql }) => /^CREATE INDEX CONCURRENTLY IF NOT EXISTS /u.test(createSql))).toBe(true);
  });

  it("uses owner ledger transitions, one advisory lock, and exact catalog truth", () => {
    // Given: the tracked runner implementation.
    const requiredCatalogs = ["pg_class", "pg_namespace", "pg_index", "pg_am", "pg_attribute", "pg_opclass", "pg_collation"];

    // When: the fail-closed protocol is inspected.
    const protocolTokens = requiredCatalogs.filter((catalog) => runnerSource.includes(catalog));

    // Then: all catalogs and state transitions are explicit, and IF NOT EXISTS is followed by catalog rechecks.
    expect(protocolTokens).toEqual(requiredCatalogs);
    expect(runnerSource).toContain("pg_advisory_lock(110514102, 3)");
    expect(runnerSource).toContain("pg_advisory_unlock(110514102, 3)");
    expect(runnerSource).toContain("'APPLYING'");
    expect(runnerSource).toContain("state='APPLIED'");
    expect(runnerSource).toContain("DROP INDEX CONCURRENTLY IF EXISTS");
    expect(runnerSource.match(/inspectIndex\(client, manifest\.name\)/gu)?.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects every valid structural mismatch dimension without treating validity as equivalence", () => {
    // Given: the exact expected User name trigram catalog projection.
    const exact = {
      expression: null,
      indexSchema: "public",
      keys: [{ column: "name", indexCollation: 100, opclass: "gin_trgm_ops", option: 0, sourceCollation: 100 }],
      method: "gin",
      name: "User_name_trgm_idx",
      predicate: null,
      ready: true,
      reloptions: [],
      tableName: "User",
      tableSchema: "public",
      unique: false,
      valid: true
    };
    const mismatches = [
      { ...exact, tableSchema: "shadow" },
      { ...exact, indexSchema: "shadow" },
      { ...exact, tableName: "AdminAction" },
      { ...exact, method: "btree" },
      { ...exact, keys: [{ ...exact.keys[0], column: "studentNumber" }] },
      { ...exact, keys: [{ ...exact.keys[0], opclass: "text_ops" }] },
      { ...exact, keys: [{ ...exact.keys[0], indexCollation: 101 }] },
      { ...exact, keys: [{ ...exact.keys[0], option: 1 }] },
      { ...exact, reloptions: ["fastupdate=off"] },
      { ...exact, predicate: "name IS NOT NULL" },
      { ...exact, expression: "lower(name)" },
      { ...exact, unique: true }
    ];

    // When: each valid candidate is compared to the manifest.
    const results = mismatches.map((candidate) => catalogDefinitionMatchesManifest(exact.name, candidate));

    // Then: schema/table, order/method/opclass/collation/options/reloptions/predicate/expression/uniqueness all fail closed.
    expect(catalogDefinitionMatchesManifest(exact.name, exact)).toBe(true);
    expect(results).toEqual(Array.from({ length: mismatches.length }, () => false));
    expect(() => catalogDefinitionMatchesManifest("unlisted_idx", exact)).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_TARGET" })
    );
  });

  it("pins descending key options and rejects btree fillfactor separately", () => {
    // Given: the exact descending audit index catalog projection.
    const exact = {
      expression: null, indexSchema: "public",
      keys: [
        { column: "createdAt", indexCollation: 0, opclass: "timestamp_ops", option: 3, sourceCollation: 0 },
        { column: "id", indexCollation: 100, opclass: "text_ops", option: 3, sourceCollation: 100 }
      ],
      method: "btree", name: "AdminAction_createdAt_id_idx", predicate: null, ready: true, reloptions: [],
      tableName: "AdminAction", tableSchema: "public", unique: false, valid: true
    };

    // When: order and reloptions drift independently.
    const reversed = { ...exact, keys: [...exact.keys].reverse() };
    const fillfactor = { ...exact, reloptions: ["fillfactor=70"] };

    // Then: both dimensions are mismatches.
    expect(catalogDefinitionMatchesManifest(exact.name, exact)).toBe(true);
    expect(catalogDefinitionMatchesManifest(exact.name, reversed)).toBe(false);
    expect(catalogDefinitionMatchesManifest(exact.name, fillfactor)).toBe(false);
  });

  it("keeps concurrent index DDL out of Prisma migrations and deployment order non-recursive", () => {
    // Given: every tracked Prisma migration and package deployment command.
    const migrationRoot = resolve("prisma/migrations");
    const migrationSql = readdirSync(migrationRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readFileSync(join(migrationRoot, entry.name, "migration.sql"), "utf8"))
      .join("\n");
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

    // When: the ordinary and online deployment phases are located.
    const deploy = packageJson.scripts["db:deploy"] as string;
    const vercel = packageJson.scripts["vercel-build"] as string;

    // Then: ordinary migration runs first, online runner second, and no Prisma migration owns concurrent DDL.
    expect(migrationSql).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/iu);
    expect(deploy).toBe("prisma migrate deploy && tsx scripts/apply-online-admin-search-indexes.ts");
    expect(vercel.indexOf("prisma migrate deploy")).toBeLessThan(vercel.indexOf("tsx scripts/apply-online-admin-search-indexes.ts"));
    expect(deploy).not.toContain("npm run db:deploy");
  });

  it("fails before connection when DIRECT_URL is missing", async () => {
    // Given: no owner connection URL.
    const operation = applyOnlineAdminSearchIndexes("");

    // When/Then: the boundary returns a typed configuration failure.
    await expect(operation).rejects.toEqual(expect.objectContaining({ code: "DIRECT_URL_MISSING", name: "OnlineIndexError" }));
    expect(OnlineIndexError).toBeDefined();
  });

  it("traverses populated PostgreSQL pages while the exact-base writer survives migration and online indexes", () => {
    // Given: a disposable migrated PostgreSQL 16 database with 127 users/reservations and 227 audits.
    const result = runPostgresScenario();

    // When: the separate runner is applied twice and catalog/query-plan truth is captured.
    const parsed = JSON.parse(result);
    const evidenceDir = process.env.EVIDENCE_DIR;
    if (evidenceDir !== undefined) {
      writeFileSync(resolve(evidenceDir, "todo3-postgres-pagination-rollout.json"), `${JSON.stringify(parsed, null, 2)}\n`, {
        flag: "wx"
      });
    }

    // Then: the owner ledger and all seven exact indexes converge to APPLIED and cleanup succeeds.
    expect(parsed).toMatchObject({
      appliedIndexes: 7,
      auditRows: 227,
      ledgerState: "APPLIED",
      reservationRows: 127,
      rollout: {
        duplicateReservations: 0,
        lostReservations: 0,
        migrationExitCode: 0,
        onlineIndexExitCode: 0,
        writerErrors: [],
        writesAdvancedDuringIndexes: true,
        writesAdvancedDuringMigration: true
      },
      traversal: {
        audits: { pages: 5, rows: 227, terminal: true, unique: 227 },
        reservations: { pages: 3, rows: 127, terminal: true, unique: 127 },
        users: { pages: 3, rows: 127, terminal: true, unique: 127 }
      },
      userRows: 127
    });
    const foundationCommit = spawnSync(
      "git",
      ["log", "-1", "--format=%H", "--", "prisma/migrations/20260811150000_add_discord_ops_v2_foundations/migration.sql"],
      { cwd: process.cwd(), encoding: "utf8" }
    ).stdout.trim();
    const expectedExactBaseSha = spawnSync("git", ["rev-parse", `${foundationCommit}^`], {
      cwd: process.cwd(), encoding: "utf8"
    }).stdout.trim();
    expect(parsed.rollout.exactBaseSha).toBe(expectedExactBaseSha);
    expect(parsed.rollout.persistedReservations).toBe(parsed.rollout.successfulWrites);
    expect(parsed.rollout.successfulWrites).toBeGreaterThan(0);
    expect(parsed.rollout.reservationsAfterMigration).toBeGreaterThan(parsed.rollout.reservationsBeforeMigration);
    expect(parsed.rollout.reservationsAfterIndexes).toBeGreaterThan(parsed.rollout.reservationsAfterMigration);
    expect(parsed.rollout.transientRetries).toEqual(expect.any(Number));
    expect(parsed.rollout.transientRetries).toBeGreaterThanOrEqual(0);
    expect(parsed.plan).toContain("User_name_trgm_idx");
    expect(parsed.cleanup).toBe("cleaned");
  }, 180_000);

  it("preserves valid mismatches, repairs only invalid targets, resumes lock timeout, rejects runtime/foundation, and serializes competitors", () => {
    // Given: a disposable migrated PostgreSQL database with duplicate populated values.
    const result = JSON.parse(runPostgresAdversarialScenario());

    // When: valid/invalid definitions, a conflicting table lock, runtime role, missing foundation, and two runners are exercised.
    // Then: every outcome is fail-closed or converges from catalog truth as specified.
    expect(result).toMatchObject({
      competitorsPassed: 2,
      finalState: "APPLIED",
      foundationCode: "FOUNDATION_MISSING",
      invalidRepairMethod: "gin",
      lockCode: "DATABASE_OPERATION_FAILED",
      resumableState: "APPLYING",
      runtimeCode: "RUNTIME_ROLE_FORBIDDEN",
      validMismatchCode: "INDEX_DEFINITION_MISMATCH",
      validMismatchPreserved: true
    });
    expect(result.cleanup).toBe("cleaned");
  }, 180_000);
});

function runPostgresScenario(): string {
  const source = String.raw`
    import { spawn, spawnSync } from 'node:child_process';
    import { mkdtemp, rm, symlink } from 'node:fs/promises';
    import { fileURLToPath } from 'node:url';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import pg from 'pg';
    import { withOperationalPostgres } from './scripts/operational-fomo-harness.mjs';
    const receipt = await withOperationalPostgres({
      operation: async ({ databaseUrl, directUrl }) => {
        const repositoryRoot = process.cwd();
        const prismaCli = fileURLToPath(import.meta.resolve('prisma/build/index.js'));
        const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
        const foundation = spawnSync('git', ['log','-1','--format=%H','--','prisma/migrations/20260811150000_add_discord_ops_v2_foundations/migration.sql'], { cwd: repositoryRoot, encoding: 'utf8' });
        if (foundation.status !== 0 || foundation.stdout.trim().length === 0) throw new Error(foundation.stderr || 'foundation commit missing');
        const exactBase = spawnSync('git', ['rev-parse', foundation.stdout.trim() + '^'], { cwd: repositoryRoot, encoding: 'utf8' });
        if (exactBase.status !== 0) throw new Error(exactBase.stderr || exactBase.stdout);
        const exactBaseSha = exactBase.stdout.trim();
        const cloneRoot = await mkdtemp(join(tmpdir(), 'todo3-exact-base-'));
        const baseRepository = join(cloneRoot, 'repo');
        let writer;
        let writerClosed;
        let writerStdout = '';
        let writerStderr = '';
        let observer;
        let baseClientGenerated = false;
        try {
          const cloned = spawnSync('git', ['clone','--local','--no-checkout',repositoryRoot,baseRepository], { encoding: 'utf8' });
          if (cloned.status !== 0) throw new Error(cloned.stderr || cloned.stdout);
          const checkedOut = spawnSync('git', ['checkout','--detach',exactBaseSha], { cwd: baseRepository, encoding: 'utf8' });
          if (checkedOut.status !== 0) throw new Error(checkedOut.stderr || checkedOut.stdout);
          await symlink(join(repositoryRoot,'node_modules'), join(baseRepository,'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
          const generated = spawnSync(process.execPath, [prismaCli, 'generate'], {
            cwd: baseRepository, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl }
          });
          if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout);
          baseClientGenerated = true;
          const baseMigrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
            cwd: baseRepository, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl }
          });
          if (baseMigrated.status !== 0) throw new Error(baseMigrated.stderr || baseMigrated.stdout);

          const client = new pg.Client({ connectionString: directUrl });
          await client.connect();
          try {
            await client.query('INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt") SELECT \'writer-user-\'||g, \'Writer \'||g, \'writer-\'||g, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM generate_series(1,5000) g');
          } finally { await client.end(); }

          const writerSource = ${JSON.stringify(EXACT_BASE_WRITER_SOURCE)};
          writer = spawn(process.execPath, [tsxCli,'--eval',writerSource], {
            cwd: baseRepository, env: { ...process.env, DATABASE_URL: databaseUrl, DEPLOYMENT_SHA: exactBaseSha, DIRECT_URL: directUrl }, shell: false, windowsHide: true,
            stdio: ['pipe','pipe','pipe']
          });
          let readySettled = false;
          let resolveReady;
          let rejectReady;
          const writerReady = new Promise((resolveHandshake, rejectHandshake) => {
            resolveReady = resolveHandshake;
            rejectReady = rejectHandshake;
          });
          writer.stdout.on('data', (chunk) => {
            writerStdout += chunk.toString();
            if (!readySettled && writerStdout.includes('READY ' + exactBaseSha)) {
              readySettled = true;
              resolveReady();
            }
          });
          writer.stderr.on('data', (chunk) => { writerStderr += chunk.toString(); });
          writerClosed = new Promise((resolveClose) => {
            writer.once('close', (status) => {
              const exitCode = status ?? -1;
              if (!readySettled) {
                readySettled = true;
                rejectReady(new Error('exact-base writer exited before readiness: exit=' + exitCode + ' stderr=' + JSON.stringify(writerStderr) + ' stdout=' + JSON.stringify(writerStdout)));
              }
              resolveClose(exitCode);
            });
            writer.once('error', (error) => {
              if (!readySettled) {
                readySettled = true;
                rejectReady(new Error('exact-base writer failed before readiness: ' + String(error)));
              }
              resolveClose(-1);
            });
          });
          const waitFor = async (predicate, label) => {
            for (let attempt = 0; attempt < 500; attempt += 1) {
              if (await predicate()) return;
              await new Promise((resolveWait) => setTimeout(resolveWait, 10));
            }
            throw new Error('timed out waiting for ' + label);
          };
          await Promise.race([
            writerReady,
            new Promise((_, rejectWait) => setTimeout(() => rejectWait(new Error('exact-base writer readiness timed out: stderr=' + JSON.stringify(writerStderr) + ' stdout=' + JSON.stringify(writerStdout))), 5000))
          ]);
          observer = new pg.Client({ connectionString: directUrl });
          await observer.connect();
          const writerCount = async () => Number((await observer.query('SELECT count(*)::int AS count FROM "Reservation" WHERE reason=\'rollout\'')).rows[0].count);
          await Promise.race([
            waitFor(async () => await writerCount() >= 5, 'initial exact-base writes'),
            writerClosed.then((exitCode) => { throw new Error('exact-base writer exited before initial writes: exit=' + exitCode + ' stderr=' + JSON.stringify(writerStderr) + ' stdout=' + JSON.stringify(writerStdout)); })
          ]);
          const beforeMigration = await writerCount();

          const migrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
            cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl }
          });
          if (migrated.status !== 0) throw new Error(migrated.stderr || migrated.stdout);
          await Promise.race([
            waitFor(async () => await writerCount() > beforeMigration, 'post-migration exact-base write'),
            writerClosed.then((exitCode) => { throw new Error('exact-base writer exited after migration: exit=' + exitCode + ' stderr=' + JSON.stringify(writerStderr) + ' stdout=' + JSON.stringify(writerStdout)); })
          ]);
          const afterMigration = await writerCount();
          await observer.query('INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt") SELECT \'qa-user-\'||g, \'김학생\'||g, \'qa-\'||g, 1, TIMESTAMPTZ \'2026-08-13 00:00:00+00\' + g * INTERVAL \'1 second\', CURRENT_TIMESTAMP FROM generate_series(1,127) g');
          await observer.query('INSERT INTO "Reservation" ("id","date","studyPeriod","userId","createdAt","updatedAt") SELECT \'qa-reservation-\'||g, \'2026-08-13\', CASE WHEN g <= 64 THEN \'EIGHTH\' ELSE \'FIRST\' END, \'qa-user-\'||g, TIMESTAMPTZ \'2026-08-13 00:00:00+00\' + g * INTERVAL \'1 second\', CURRENT_TIMESTAMP FROM generate_series(1,127) g');
          await observer.query('INSERT INTO "AdminAction" ("id","action","reason","createdAt") SELECT \'qa-audit-\'||g, \'QA_ACTION\', \'qa reason \'||g, TIMESTAMPTZ \'2026-08-13 00:00:00+00\' + g * INTERVAL \'1 second\' FROM generate_series(1,227) g');
          const applied = spawnSync(process.execPath, [tsxCli, 'scripts/apply-online-admin-search-indexes.ts'], {
            cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, DIRECT_URL: directUrl }
          });
          if (applied.status !== 0) throw new Error(applied.stderr || applied.stdout);
          await Promise.race([
            waitFor(async () => await writerCount() > afterMigration, 'post-index exact-base write'),
            writerClosed.then((exitCode) => { throw new Error('exact-base writer exited after online indexes: exit=' + exitCode + ' stderr=' + JSON.stringify(writerStderr) + ' stdout=' + JSON.stringify(writerStdout)); })
          ]);
          const afterIndexes = await writerCount();
          writer.stdin.write('STOP\\n');
          writer.stdin.end();
          const writerExitCode = await writerClosed;
          if (writerExitCode !== 0) throw new Error(writerStderr || writerStdout);
          const writerResultMatch = /\{[^\r\n]+\}/u.exec(writerStdout);
          if (writerResultMatch === null) throw new Error('exact-base writer result missing: ' + JSON.stringify(writerStdout));
          const writerResult = JSON.parse(writerResultMatch[0]);
          const persisted = await observer.query('SELECT count(*)::int AS count,count(DISTINCT ("userId",date,"studyPeriod"))::int AS distinct_count FROM "Reservation" WHERE reason=\'rollout\'');

          const traverseUsers = async () => {
            const seen = []; let after = null; let pages = 0; let terminal = false;
            while (!terminal) {
              const result = await observer.query('SELECT id,"createdAt" FROM "User" WHERE "studentNumber" LIKE \'qa-%\' AND "createdAt" <= TIMESTAMPTZ \'2026-08-13 00:02:07+00\' AND ($1::timestamptz IS NULL OR ("createdAt",id) > ($1::timestamptz,$2::text)) ORDER BY "createdAt" ASC,id ASC LIMIT 51',[after?.createdAt ?? null,after?.id ?? null]);
              const page = result.rows.slice(0,50); pages += 1; seen.push(...page.map(({ id }) => id)); terminal = result.rows.length <= 50;
              const last = page.at(-1); after = terminal || last === undefined ? null : { createdAt: last.createdAt, id: last.id };
            }
            return { pages, rows: seen.length, terminal: after === null, unique: new Set(seen).size };
          };
          const traverseReservations = async () => {
            const seen = []; let after = null; let pages = 0; let terminal = false;
            while (!terminal) {
              const result = await observer.query('SELECT id,"studyPeriod","createdAt" FROM "Reservation" WHERE date=\'2026-08-13\' AND "createdAt" <= TIMESTAMPTZ \'2026-08-13 00:02:07+00\' AND ($1::text IS NULL OR ("studyPeriod","createdAt",id) > ($1::text,$2::timestamptz,$3::text)) ORDER BY "studyPeriod" ASC,"createdAt" ASC,id ASC LIMIT 51',[after?.studyPeriod ?? null,after?.createdAt ?? null,after?.id ?? null]);
              const page = result.rows.slice(0,50); pages += 1; seen.push(...page.map(({ id }) => id)); terminal = result.rows.length <= 50;
              const last = page.at(-1); after = terminal || last === undefined ? null : { studyPeriod: last.studyPeriod, createdAt: last.createdAt, id: last.id };
            }
            return { pages, rows: seen.length, terminal: after === null, unique: new Set(seen).size };
          };
          const traverseAudits = async () => {
            const seen = []; let after = null; let pages = 0; let terminal = false;
            while (!terminal) {
              const result = await observer.query('SELECT id,"createdAt" FROM "AdminAction" WHERE action=\'QA_ACTION\' AND "createdAt" <= TIMESTAMPTZ \'2026-08-13 00:03:47+00\' AND ($1::timestamptz IS NULL OR ("createdAt",id) < ($1::timestamptz,$2::text)) ORDER BY "createdAt" DESC,id DESC LIMIT 51',[after?.createdAt ?? null,after?.id ?? null]);
              const page = result.rows.slice(0,50); pages += 1; seen.push(...page.map(({ id }) => id)); terminal = result.rows.length <= 50;
              const last = page.at(-1); after = terminal || last === undefined ? null : { createdAt: last.createdAt, id: last.id };
            }
            return { pages, rows: seen.length, terminal: after === null, unique: new Set(seen).size };
          };
          await observer.query('SET enable_seqscan=off');
          const ledger = await observer.query("SELECT state FROM app_private.online_schema_migrations WHERE name='admin-search-indexes-v1'");
          const indexes = await observer.query("SELECT count(*)::int AS count FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=ANY($1) AND i.indisvalid AND i.indisready", [[
            'User_name_trgm_idx','User_studentNumber_trgm_idx','AdminAction_action_trgm_idx','AdminAction_reason_trgm_idx',
            'User_createdAt_id_idx','Reservation_date_studyPeriod_createdAt_id_idx','AdminAction_createdAt_id_idx'
          ]]);
          const plan = await observer.query("EXPLAIN (FORMAT JSON) SELECT id FROM \"User\" WHERE name LIKE '%김학생127%'");
          const counts = await observer.query("SELECT (SELECT count(*)::int FROM \"User\" WHERE \"studentNumber\" LIKE 'qa-%') AS users,(SELECT count(*)::int FROM \"Reservation\" WHERE date='2026-08-13') AS reservations,(SELECT count(*)::int FROM \"AdminAction\" WHERE action='QA_ACTION') AS audits");
          const traversal = { users: await traverseUsers(), reservations: await traverseReservations(), audits: await traverseAudits() };
          await observer.end();
          observer = undefined;
          return {
            appliedIndexes: indexes.rows[0].count, auditRows: counts.rows[0].audits, ledgerState: ledger.rows[0].state,
            plan: JSON.stringify(plan.rows[0]), reservationRows: counts.rows[0].reservations,
            rollout: {
              duplicateReservations: Number(persisted.rows[0].count) - Number(persisted.rows[0].distinct_count),
              exactBaseSha: writerResult.commitSha,
              lostReservations: writerResult.successfulWrites - Number(persisted.rows[0].count),
              migrationExitCode: migrated.status,
              onlineIndexExitCode: applied.status,
              persistedReservations: Number(persisted.rows[0].count),
              reservationsAfterIndexes: afterIndexes,
              reservationsAfterMigration: afterMigration,
              reservationsBeforeMigration: beforeMigration,
              successfulWrites: writerResult.successfulWrites,
              transientRetries: writerResult.transientRetries,
              writerErrors: writerResult.writerErrors,
              writesAdvancedDuringIndexes: afterIndexes > afterMigration,
              writesAdvancedDuringMigration: afterMigration > beforeMigration
            },
            traversal, userRows: counts.rows[0].users
          };
        } finally {
          if (writer !== undefined && writer.exitCode === null) {
            writer.stdin.write('STOP\\n'); writer.stdin.end();
            if (writerClosed !== undefined) {
              const closed = await Promise.race([writerClosed.then(() => true), new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5000))]);
              if (!closed) writer.kill();
            }
          }
          if (observer !== undefined) await observer.end().catch(() => undefined);
          if (baseClientGenerated) {
            const restoredClient = spawnSync(process.execPath, [prismaCli, 'generate'], {
              cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl }
            });
            if (restoredClient.status !== 0) throw new Error(restoredClient.stderr || restoredClient.stdout);
          }
          await rm(cloneRoot, { recursive: true, force: true });
        }
      }, timeoutMs: 90_000
    });
    process.stdout.write(JSON.stringify({ ...receipt, cleanup: 'cleaned' }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 170_000
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function runPostgresAdversarialScenario(): string {
  const source = String.raw`
    import { spawn, spawnSync } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import pg from 'pg';
    import { withOperationalPostgres } from './scripts/operational-fomo-harness.mjs';
    const receipt = await withOperationalPostgres({ operation: async ({ databaseUrl, directUrl }) => {
      const prismaCli = fileURLToPath(import.meta.resolve('prisma/build/index.js'));
      const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
      const migrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl } });
      if (migrated.status !== 0) throw new Error(migrated.stderr || migrated.stdout);
      const run = (url = directUrl) => spawnSync(process.execPath, [tsxCli, 'scripts/apply-online-admin-search-indexes.ts'], {
        cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DIRECT_URL: url }
      });
      const code = (result) => { try { return JSON.parse(result.stderr.trim()).code; } catch { return 'UNPARSED'; } };
      const admin = new pg.Client({ connectionString: directUrl });
      await admin.connect();
      try {
        await admin.query("INSERT INTO \"User\" (\"id\",\"name\",\"studentNumber\",\"generation\",\"updatedAt\") VALUES ('m1','duplicate','m1',1,CURRENT_TIMESTAMP),('m2','duplicate','m2',1,CURRENT_TIMESTAMP)");
        await admin.query('CREATE INDEX "User_name_trgm_idx" ON "User" USING btree ("name")');
        const mismatch = run();
        const preserved = await admin.query("SELECT i.indisvalid,am.amname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam WHERE c.relname='User_name_trgm_idx'");
        await admin.query('DROP INDEX "User_name_trgm_idx"');
        try { await admin.query('CREATE UNIQUE INDEX CONCURRENTLY "User_name_trgm_idx" ON "User" USING btree ("name")'); } catch {}
        const invalid = await admin.query("SELECT indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='User_name_trgm_idx'");
        if (invalid.rows[0]?.indisvalid !== false) throw new Error('invalid fixture was not created');
        const repaired = run();
        if (repaired.status !== 0) throw new Error(repaired.stderr || repaired.stdout);
        const repairMethod = await admin.query("SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid=c.relam WHERE c.relname='User_name_trgm_idx'");
        await admin.query('DROP INDEX CONCURRENTLY "User_createdAt_id_idx"');
        const locker = new pg.Client({ connectionString: directUrl });
        await locker.connect();
        await locker.query('BEGIN');
        await locker.query('LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE');
        const blocked = run();
        const applying = await admin.query("SELECT state FROM app_private.online_schema_migrations WHERE name='admin-search-indexes-v1'");
        await locker.query('ROLLBACK');
        await locker.end();
        const resumed = run();
        if (resumed.status !== 0) throw new Error(resumed.stderr || resumed.stdout);
        const runtimePassword = 'runtime_qa_password';
        await admin.query("ALTER ROLE info_room_runtime WITH LOGIN PASSWORD 'runtime_qa_password'");
        const runtimeUrl = new URL(directUrl); runtimeUrl.username='info_room_runtime'; runtimeUrl.password=runtimePassword;
        const runtime = run(runtimeUrl.toString());
        await admin.query('ALTER TABLE app_private.online_schema_migrations RENAME TO online_schema_migrations_qa_missing');
        const foundation = run();
        await admin.query('ALTER TABLE app_private.online_schema_migrations_qa_missing RENAME TO online_schema_migrations');
        const asyncRun = () => new Promise((resolveRun) => {
          const child = spawn(process.execPath, [tsxCli, 'scripts/apply-online-admin-search-indexes.ts'], { cwd: process.cwd(), env: { ...process.env, DIRECT_URL: directUrl }, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
          let stderr=''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
          child.once('close', (status) => resolveRun({ status, stderr }));
          child.once('error', (error) => resolveRun({ status: -1, stderr: String(error) }));
        });
        const competitors = await Promise.all([asyncRun(), asyncRun()]);
        const final = await admin.query("SELECT state FROM app_private.online_schema_migrations WHERE name='admin-search-indexes-v1'");
        return { competitorsPassed: competitors.filter(({ status }) => status === 0).length, finalState: final.rows[0].state,
          foundationCode: code(foundation), invalidRepairMethod: repairMethod.rows[0].amname, lockCode: code(blocked),
          resumableState: applying.rows[0].state, runtimeCode: code(runtime), validMismatchCode: code(mismatch),
          validMismatchPreserved: preserved.rows[0].indisvalid === true && preserved.rows[0].amname === 'btree' };
      } finally { await admin.end(); }
    }, timeoutMs: 90_000 });
    process.stdout.write(JSON.stringify({ ...receipt, cleanup: 'cleaned' }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(), encoding: "utf8", timeout: 170_000
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
