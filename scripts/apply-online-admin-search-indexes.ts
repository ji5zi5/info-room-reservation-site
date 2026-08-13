// allow: SIZE_OK — the structural manifest, catalog verifier, and owner-only runner form one auditable protocol.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { z } from "zod";

const { Client } = pg;
const LEDGER_NAME = "admin-search-indexes-v1";
const ADVISORY_LOCK_SQL = "SELECT pg_advisory_lock(110514102, 3)";
const ADVISORY_UNLOCK_SQL = "SELECT pg_advisory_unlock(110514102, 3)";
export const ONLINE_INDEX_SESSION_COMMANDS = [
  "SET lock_timeout='2s'",
  "SET statement_timeout='5min'",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm"
] as const;

type IndexKey = {
  readonly column: string;
  readonly opclass: string;
  readonly opclassDefault: boolean;
  readonly opclassExtension: "pg_trgm" | null;
  readonly opclassInput: "source";
  readonly opclassNamespace: "pg_catalog" | "public";
  readonly option: number;
};

type IndexManifest = {
  readonly createSql: string;
  readonly keys: readonly IndexKey[];
  readonly method: "btree" | "gin";
  readonly name: string;
  readonly reloptions: readonly string[];
  readonly schema: "public";
  readonly table: "AdminAction" | "Reservation" | "User";
};

const GIN_TRGM_OPCLASS = {
  opclassDefault: false, opclassExtension: "pg_trgm", opclassInput: "source", opclassNamespace: "public"
} as const;
const BTREE_DEFAULT_OPCLASS = {
  opclassDefault: true, opclassExtension: null, opclassInput: "source", opclassNamespace: "pg_catalog"
} as const;

export const ONLINE_INDEX_MANIFEST = [
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_name_trgm_idx" ON "public"."User" USING gin ("name" gin_trgm_ops)',
    keys: [{ column: "name", opclass: "gin_trgm_ops", option: 0, ...GIN_TRGM_OPCLASS }], method: "gin", name: "User_name_trgm_idx", reloptions: [], schema: "public", table: "User"
  },
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_studentNumber_trgm_idx" ON "public"."User" USING gin ("studentNumber" gin_trgm_ops)',
    keys: [{ column: "studentNumber", opclass: "gin_trgm_ops", option: 0, ...GIN_TRGM_OPCLASS }], method: "gin", name: "User_studentNumber_trgm_idx", reloptions: [], schema: "public", table: "User"
  },
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAction_action_trgm_idx" ON "public"."AdminAction" USING gin ("action" gin_trgm_ops)',
    keys: [{ column: "action", opclass: "gin_trgm_ops", option: 0, ...GIN_TRGM_OPCLASS }], method: "gin", name: "AdminAction_action_trgm_idx", reloptions: [], schema: "public", table: "AdminAction"
  },
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAction_reason_trgm_idx" ON "public"."AdminAction" USING gin ("reason" gin_trgm_ops)',
    keys: [{ column: "reason", opclass: "gin_trgm_ops", option: 0, ...GIN_TRGM_OPCLASS }], method: "gin", name: "AdminAction_reason_trgm_idx", reloptions: [], schema: "public", table: "AdminAction"
  },
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_createdAt_id_idx" ON "public"."User" USING btree ("createdAt" ASC, "id" ASC)',
    keys: [
      { column: "createdAt", opclass: "timestamp_ops", option: 0, ...BTREE_DEFAULT_OPCLASS },
      { column: "id", opclass: "text_ops", option: 0, ...BTREE_DEFAULT_OPCLASS }
    ],
    method: "btree", name: "User_createdAt_id_idx", reloptions: [], schema: "public", table: "User"
  },
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Reservation_date_studyPeriod_createdAt_id_idx" ON "public"."Reservation" USING btree ("date" ASC, "studyPeriod" ASC, "createdAt" ASC, "id" ASC)',
    keys: [
      { column: "date", opclass: "text_ops", option: 0, ...BTREE_DEFAULT_OPCLASS },
      { column: "studyPeriod", opclass: "text_ops", option: 0, ...BTREE_DEFAULT_OPCLASS },
      { column: "createdAt", opclass: "timestamp_ops", option: 0, ...BTREE_DEFAULT_OPCLASS },
      { column: "id", opclass: "text_ops", option: 0, ...BTREE_DEFAULT_OPCLASS }
    ], method: "btree", name: "Reservation_date_studyPeriod_createdAt_id_idx", reloptions: [], schema: "public", table: "Reservation"
  },
  {
    createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAction_createdAt_id_idx" ON "public"."AdminAction" USING btree ("createdAt" DESC, "id" DESC)',
    keys: [
      { column: "createdAt", opclass: "timestamp_ops", option: 3, ...BTREE_DEFAULT_OPCLASS },
      { column: "id", opclass: "text_ops", option: 3, ...BTREE_DEFAULT_OPCLASS }
    ],
    method: "btree", name: "AdminAction_createdAt_id_idx", reloptions: [], schema: "public", table: "AdminAction"
  }
] as const satisfies readonly IndexManifest[];

const checksumMaterial = JSON.stringify({
  advisoryLock: ADVISORY_LOCK_SQL,
  manifest: ONLINE_INDEX_MANIFEST,
  statements: [...ONLINE_INDEX_SESSION_COMMANDS, ...ONLINE_INDEX_MANIFEST.map((index) => index.createSql)]
});
export const ONLINE_INDEX_CHECKSUM = createHash("sha256").update(checksumMaterial).digest("hex");

export const ONLINE_INDEX_ERROR_CODES = [
  "CHECKSUM_MISMATCH", "DATABASE_OPERATION_FAILED", "DIRECT_URL_MISSING", "FOUNDATION_MISSING",
  "INDEX_DEFINITION_MISMATCH", "RUNTIME_ROLE_FORBIDDEN", "UNKNOWN_TARGET"
] as const;
export type OnlineIndexErrorCode = (typeof ONLINE_INDEX_ERROR_CODES)[number];

export class OnlineIndexError extends Error {
  public override readonly name = "OnlineIndexError";

  public constructor(public readonly code: OnlineIndexErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const FoundationSchema = z.object({ foundation: z.string().nullable(), ownerAllowed: z.boolean() });
const LedgerSchema = z.object({ checksum: z.string(), state: z.enum(["APPLYING", "APPLIED"]) });
const CatalogKeySchema = z.object({
  column: z.string().nullable(), expectedOpclassOid: z.number().int().positive().nullable(), indexCollation: z.number(),
  opclass: z.string(), opclassDefault: z.boolean(), opclassExtension: z.string().nullable(),
  opclassInputType: z.number().int().positive(), opclassMethod: z.string(), opclassNamespace: z.string(),
  opclassOid: z.number().int().positive(), option: z.number(), sourceCollation: z.number(), sourceType: z.number().int().positive()
});
const CatalogIndexSchema = z.object({
  expression: z.string().nullable(), indexSchema: z.string(), keys: z.array(CatalogKeySchema), method: z.string(),
  name: z.string(), predicate: z.string().nullable(), ready: z.boolean(), reloptions: z.array(z.string()),
  tableName: z.string(), tableSchema: z.string(), unique: z.boolean(), valid: z.boolean()
});
type CatalogIndex = z.infer<typeof CatalogIndexSchema>;

export function catalogDefinitionMatchesManifest(name: string, candidate: unknown): boolean {
  const manifest = ONLINE_INDEX_MANIFEST.find((index) => index.name === name);
  if (manifest === undefined) throw new OnlineIndexError("UNKNOWN_TARGET", `index ${name} is not in the structural manifest`);
  const parsed = CatalogIndexSchema.safeParse(candidate);
  return parsed.success && matchesManifest(parsed.data, manifest);
}

export async function applyOnlineAdminSearchIndexes(directUrl = process.env.DIRECT_URL): Promise<void> {
  if (directUrl === undefined || directUrl.length === 0) {
    throw new OnlineIndexError("DIRECT_URL_MISSING", "DIRECT_URL is required for owner-only online index application");
  }
  const client = new Client({ connectionString: directUrl });
  let connected = false;
  let locked = false;
  try {
    await client.connect();
    connected = true;
    await client.query(ADVISORY_LOCK_SQL);
    locked = true;
    await client.query(ONLINE_INDEX_SESSION_COMMANDS[0]);
    await client.query(ONLINE_INDEX_SESSION_COMMANDS[1]);
    const foundationResult = await client.query(`
      SELECT to_regclass('app_private.online_schema_migrations')::text AS foundation,
             CASE WHEN c.oid IS NULL THEN false ELSE pg_has_role(current_user, c.relowner, 'USAGE') END AS "ownerAllowed"
      FROM (SELECT to_regclass('app_private.online_schema_migrations') AS oid) target
      LEFT JOIN pg_class c ON c.oid=target.oid
    `);
    const foundation = FoundationSchema.parse(foundationResult.rows[0]);
    if (foundation.foundation === null) throw new OnlineIndexError("FOUNDATION_MISSING", "Todo 1 online migration ledger is missing");
    if (!foundation.ownerAllowed) throw new OnlineIndexError("RUNTIME_ROLE_FORBIDDEN", "online indexes require the ledger owner role");
    await client.query(ONLINE_INDEX_SESSION_COMMANDS[2]);
    const ledgerResult = await client.query(
      "SELECT checksum,state FROM app_private.online_schema_migrations WHERE name=$1", [LEDGER_NAME]
    );
    const existingLedger = ledgerResult.rows[0] === undefined ? null : LedgerSchema.parse(ledgerResult.rows[0]);
    if (existingLedger !== null && existingLedger.checksum !== ONLINE_INDEX_CHECKSUM) {
      throw new OnlineIndexError("CHECKSUM_MISMATCH", "online index ledger checksum does not match the structural manifest");
    }
    await client.query(`
      INSERT INTO app_private.online_schema_migrations (name,checksum,state,started_at,applied_at,last_error)
      VALUES ($1,$2,'APPLYING',CURRENT_TIMESTAMP,NULL,NULL)
      ON CONFLICT (name) DO UPDATE SET state='APPLYING',applied_at=NULL,last_error=NULL
    `, [LEDGER_NAME, ONLINE_INDEX_CHECKSUM]);

    for (const manifest of ONLINE_INDEX_MANIFEST) {
      const current = await inspectIndex(client, manifest.name);
      if (current !== null && current.valid && (!current.ready || !matchesManifest(current, manifest))) {
        throw mismatch(manifest, current);
      }
      if (current !== null && !current.valid) {
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${manifest.name}"`);
      }
      if (current === null || !current.valid) await client.query(manifest.createSql);
      const applied = await inspectIndex(client, manifest.name);
      if (applied === null || !matchesManifest(applied, manifest) || !applied.valid || !applied.ready) {
        throw mismatch(manifest, applied);
      }
    }

    for (const manifest of ONLINE_INDEX_MANIFEST) {
      const verified = await inspectIndex(client, manifest.name);
      if (verified === null || !verified.valid || !verified.ready || !matchesManifest(verified, manifest)) {
        throw mismatch(manifest, verified);
      }
    }
    await client.query("BEGIN");
    try {
      const marked = await client.query(`
        UPDATE app_private.online_schema_migrations
        SET state='APPLIED',applied_at=CURRENT_TIMESTAMP,last_error=NULL
        WHERE name=$1 AND checksum=$2 AND state='APPLYING'
      `, [LEDGER_NAME, ONLINE_INDEX_CHECKSUM]);
      if (marked.rowCount !== 1) throw new OnlineIndexError("CHECKSUM_MISMATCH", "ledger changed before APPLIED transition");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof OnlineIndexError) throw error;
    throw new OnlineIndexError("DATABASE_OPERATION_FAILED", "online index application failed", { cause: error });
  } finally {
    if (locked) await client.query(ADVISORY_UNLOCK_SQL);
    if (connected) await client.end();
  }
}

async function inspectIndex(client: pg.Client, name: string): Promise<CatalogIndex | null> {
  const result = await client.query(`
    SELECT ins.nspname AS "indexSchema", ic.relname AS name, tns.nspname AS "tableSchema", tc.relname AS "tableName",
           am.amname AS method, i.indisunique AS unique, i.indisvalid AS valid, i.indisready AS ready,
           pg_get_expr(i.indpred,i.indrelid) AS predicate, pg_get_expr(i.indexprs,i.indrelid) AS expression,
           COALESCE(ic.reloptions,ARRAY[]::text[]) AS reloptions,
           COALESCE(json_agg(json_build_object(
             'column',a.attname,'opclass',opc.opcname,'indexCollation',COALESCE(coll.oid,0)::int,
             'sourceCollation',COALESCE(a.attcollation,0)::int,'sourceType',a.atttypid::int,'option',k.option,
             'opclassOid',opc.oid::int,'expectedOpclassOid',expected_opc.oid::int,
             'opclassNamespace',opn.nspname,'opclassDefault',opc.opcdefault,
             'opclassInputType',opc.opcintype::int,'opclassMethod',opam.amname,'opclassExtension',opext.extname
           ) ORDER BY k.ordinality) FILTER (WHERE k.ordinality IS NOT NULL),'[]'::json) AS keys
    FROM pg_class ic
    JOIN pg_namespace ins ON ins.oid=ic.relnamespace
    JOIN pg_index i ON i.indexrelid=ic.oid
    JOIN pg_class tc ON tc.oid=i.indrelid
    JOIN pg_namespace tns ON tns.oid=tc.relnamespace
    JOIN pg_am am ON am.oid=ic.relam
    LEFT JOIN LATERAL unnest(i.indkey::smallint[],i.indclass::oid[],i.indcollation::oid[],i.indoption::smallint[])
      WITH ORDINALITY AS k(attnum,opclass_oid,collation_oid,option,ordinality) ON true
    LEFT JOIN pg_attribute a ON a.attrelid=tc.oid AND a.attnum=k.attnum
    LEFT JOIN pg_opclass opc ON opc.oid=k.opclass_oid
    LEFT JOIN pg_namespace opn ON opn.oid=opc.opcnamespace
    LEFT JOIN pg_am opam ON opam.oid=opc.opcmethod
    LEFT JOIN pg_depend opd ON opd.classid='pg_opclass'::regclass AND opd.objid=opc.oid
      AND opd.refclassid='pg_extension'::regclass AND opd.deptype='e'
    LEFT JOIN pg_extension opext ON opext.oid=opd.refobjid
    LEFT JOIN LATERAL (
      SELECT expected.oid
      FROM pg_opclass expected
      JOIN pg_namespace expected_ns ON expected_ns.oid=expected.opcnamespace
      JOIN pg_am expected_am ON expected_am.oid=expected.opcmethod
      LEFT JOIN pg_depend expected_dep ON expected_dep.classid='pg_opclass'::regclass AND expected_dep.objid=expected.oid
        AND expected_dep.refclassid='pg_extension'::regclass AND expected_dep.deptype='e'
      LEFT JOIN pg_extension expected_ext ON expected_ext.oid=expected_dep.refobjid
      WHERE expected.opcname=opc.opcname AND expected.opcintype=a.atttypid
        AND ((am.amname='btree' AND expected_am.amname='btree' AND expected.opcdefault AND expected_ns.nspname='pg_catalog')
          OR (am.amname='gin' AND expected_am.amname='gin' AND NOT expected.opcdefault
            AND expected_ns.nspname='public' AND expected_ext.extname='pg_trgm'))
      ORDER BY expected.oid
      LIMIT 1
    ) expected_opc ON true
    LEFT JOIN pg_collation coll ON coll.oid=k.collation_oid
    WHERE ic.relkind='i' AND ic.relname=$1
    GROUP BY ins.nspname,ic.relname,tns.nspname,tc.relname,am.amname,i.indisunique,i.indisvalid,
             i.indisready,i.indpred,i.indexprs,i.indrelid,ic.reloptions
  `, [name]);
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) throw new OnlineIndexError("UNKNOWN_TARGET", `multiple indexes named ${name} exist`);
  return CatalogIndexSchema.parse(result.rows[0]);
}

function matchesManifest(actual: CatalogIndex, expected: IndexManifest): boolean {
  return actual.indexSchema === expected.schema && actual.tableSchema === expected.schema && actual.tableName === expected.table &&
    actual.name === expected.name && actual.method === expected.method && !actual.unique && actual.predicate === null &&
    actual.expression === null && equalStrings([...actual.reloptions].sort(), [...expected.reloptions].sort()) &&
    actual.keys.length === expected.keys.length && actual.keys.every((key, index) => {
      const expectedKey = expected.keys[index];
      return expectedKey !== undefined && key.column === expectedKey.column && key.opclass === expectedKey.opclass &&
        key.option === expectedKey.option && key.indexCollation === key.sourceCollation &&
        key.opclassOid === key.expectedOpclassOid && key.opclassMethod === expected.method &&
        key.opclassInputType === key.sourceType && expectedKey.opclassInput === "source" &&
        key.opclassNamespace === expectedKey.opclassNamespace && key.opclassDefault === expectedKey.opclassDefault &&
        key.opclassExtension === expectedKey.opclassExtension;
    });
}

function mismatch(expected: IndexManifest, actual: CatalogIndex | null): OnlineIndexError {
  return new OnlineIndexError(
    "INDEX_DEFINITION_MISMATCH",
    `index ${expected.name} does not match the structural manifest: ${JSON.stringify(actual)}`
  );
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function main(): Promise<void> {
  await applyOnlineAdminSearchIndexes();
  process.stdout.write(`${JSON.stringify({ checksum: ONLINE_INDEX_CHECKSUM, indexes: ONLINE_INDEX_MANIFEST.map(({ name }) => name), state: "APPLIED" })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    const output = error instanceof OnlineIndexError
      ? { code: error.code, message: error.message, name: error.name }
      : { code: "UNKNOWN", message: String(error), name: "Error" };
    process.stderr.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 1;
  });
}
