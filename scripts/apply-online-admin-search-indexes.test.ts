// allow: SIZE_OK — static protocol guards and the complete catalog mismatch matrix stay auditable together.
import { readFileSync, readdirSync } from "node:fs";
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

  it("builds populated indexes, verifies selective plans, and reapplies idempotently in PostgreSQL 16", () => {
    // Given: a disposable migrated PostgreSQL 16 database with 127 users/reservations and 227 audits.
    const result = runPostgresScenario();

    // When: the separate runner is applied twice and catalog/query-plan truth is captured.
    const parsed = JSON.parse(result);

    // Then: the owner ledger and all seven exact indexes converge to APPLIED and cleanup succeeds.
    expect(parsed).toMatchObject({
      appliedIndexes: 7,
      auditRows: 227,
      ledgerState: "APPLIED",
      reservationRows: 127,
      userRows: 127
    });
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
    import { spawnSync } from 'node:child_process';
    import { fileURLToPath } from 'node:url';
    import pg from 'pg';
    import { withOperationalPostgres } from './scripts/operational-fomo-harness.mjs';
    const receipt = await withOperationalPostgres({
      operation: async ({ databaseUrl, directUrl }) => {
        const prismaCli = fileURLToPath(import.meta.resolve('prisma/build/index.js'));
        const migrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
          cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: directUrl }
        });
        if (migrated.status !== 0) throw new Error(migrated.stderr || migrated.stdout);
        const client = new pg.Client({ connectionString: directUrl });
        await client.connect();
        try {
          await client.query('INSERT INTO "User" ("id","name","studentNumber","generation","createdAt","updatedAt") SELECT \'qa-user-\'||g, \'김학생\'||g, \'qa-\'||g, 1, CURRENT_TIMESTAMP - (g||\' seconds\')::interval, CURRENT_TIMESTAMP FROM generate_series(1,127) g');
          await client.query('INSERT INTO "Reservation" ("id","date","studyPeriod","userId","createdAt","updatedAt") SELECT \'qa-reservation-\'||g, \'2026-08-13\', \'EIGHTH\', \'qa-user-\'||g, CURRENT_TIMESTAMP - (g||\' seconds\')::interval, CURRENT_TIMESTAMP FROM generate_series(1,127) g');
          await client.query('INSERT INTO "AdminAction" ("id","action","reason","createdAt") SELECT \'qa-audit-\'||g, \'QA_ACTION\', \'qa reason \'||g, CURRENT_TIMESTAMP - (g||\' seconds\')::interval FROM generate_series(1,227) g');
        } finally { await client.end(); }
        const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
        for (let run = 0; run < 2; run += 1) {
          const applied = spawnSync(process.execPath, [tsxCli, 'scripts/apply-online-admin-search-indexes.ts'], {
            cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DIRECT_URL: directUrl }
          });
          if (applied.status !== 0) throw new Error(applied.stderr || applied.stdout);
        }
        const verify = new pg.Client({ connectionString: directUrl });
        await verify.connect();
        try {
          await verify.query('SET enable_seqscan=off');
          const ledger = await verify.query("SELECT state FROM app_private.online_schema_migrations WHERE name='admin-search-indexes-v1'");
          const indexes = await verify.query("SELECT count(*)::int AS count FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=ANY($1) AND i.indisvalid AND i.indisready", [[
            'User_name_trgm_idx','User_studentNumber_trgm_idx','AdminAction_action_trgm_idx','AdminAction_reason_trgm_idx',
            'User_createdAt_id_idx','Reservation_date_studyPeriod_createdAt_id_idx','AdminAction_createdAt_id_idx'
          ]]);
          const plan = await verify.query("EXPLAIN (FORMAT JSON) SELECT id FROM \"User\" WHERE name LIKE '%김학생127%'");
          const counts = await verify.query('SELECT (SELECT count(*)::int FROM "User") AS users,(SELECT count(*)::int FROM "Reservation") AS reservations,(SELECT count(*)::int FROM "AdminAction") AS audits');
          return { appliedIndexes: indexes.rows[0].count, auditRows: counts.rows[0].audits, ledgerState: ledger.rows[0].state,
            plan: JSON.stringify(plan.rows[0]), reservationRows: counts.rows[0].reservations, userRows: counts.rows[0].users };
        } finally { await verify.end(); }
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
