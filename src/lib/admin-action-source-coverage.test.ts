import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const directAdminActionRouteFiles = [
  "src/app/api/admin/notification-settings/route.ts",
  "src/app/api/admin/notifications/closed-periods/send/route.ts",
  "src/app/api/admin/period-settings/route.ts",
  "src/app/api/admin/reservations/admin-create-reservation.ts",
  "src/app/api/admin/reservations/[id]/cancel/route.ts",
  "src/app/api/admin/reservations/[id]/no-show/route.ts",
  "src/app/api/admin/users/[id]/restriction/route.ts",
  "src/app/api/admin/users/[id]/sessions/revoke/route.ts"
] as const;

const studentCancellationAuditContract = {
  capability: "app_private.cancel_owned_student_reservation",
  ipHashArgument: "${ipHash}",
  ipHashColumn: '"ipHash"',
  migrationFile: "prisma/migrations/20260810020000_add_owned_student_cancellation_capability/migration.sql",
  requestIpHashArgument: "request_ip_hash",
  routeFile: "src/app/api/reservations/[id]/route.ts",
  table: '"public"."AdminAction"'
} as const;

describe("admin action source coverage", () => {
  it("records hashed request source for every route-level admin action write", () => {
    for (const filePath of directAdminActionRouteFiles) {
      const source = readFileSync(join(process.cwd(), filePath), "utf8");

      expect(source, `${filePath} should create an AdminAction`).toContain("adminAction.create");
      expect(source, `${filePath} should compute hashed request source`).toContain("hashRequestClientIp(request)");
      expect(source, `${filePath} should persist AdminAction.ipHash`).toContain("ipHash");
    }
  });

  it("binds the hashed student cancellation request source to the SQL capability AdminAction insert", () => {
    // Given
    const routeSource = readFileSync(join(process.cwd(), studentCancellationAuditContract.routeFile), "utf8");
    const migrationSource = readFileSync(join(process.cwd(), studentCancellationAuditContract.migrationFile), "utf8");

    // When
    const capabilityArguments = extractCallArguments(routeSource, studentCancellationAuditContract.capability);
    const adminActionInsert = extractInsertContract(migrationSource, studentCancellationAuditContract.table);

    // Then
    expect(routeSource).toContain("const ipHash = hashRequestClientIp(request)");
    expect(capabilityArguments[1]).toBe(studentCancellationAuditContract.ipHashArgument);
    expect(adminActionInsert.columns.at(-1)).toBe(studentCancellationAuditContract.ipHashColumn);
    expect(adminActionInsert.values.trimEnd().endsWith(studentCancellationAuditContract.requestIpHashArgument)).toBe(true);
  });
});

function extractCallArguments(source: string, functionName: string): readonly string[] {
  const callStart = `SELECT ${functionName}(`;
  const start = source.indexOf(callStart);
  const end = source.indexOf(") AS outcome", start + callStart.length);
  if (start < 0 || end < 0) {
    throw new SourceContractError(`Missing SQL call for ${functionName}`);
  }
  return source
    .slice(start + callStart.length, end)
    .split(",")
    .map((argument) => argument.trim());
}

function extractInsertContract(
  source: string,
  table: string
): { readonly columns: readonly string[]; readonly values: string } {
  const insertStart = `INSERT INTO ${table} (`;
  const columnsEndMarker = ") VALUES (";
  const start = source.indexOf(insertStart);
  const columnsEnd = source.indexOf(columnsEndMarker, start + insertStart.length);
  const statementEnd = source.indexOf("\n    );", columnsEnd + columnsEndMarker.length);
  if (start < 0 || columnsEnd < 0 || statementEnd < 0) {
    throw new SourceContractError(`Missing structured INSERT for ${table}`);
  }
  return {
    columns: source
      .slice(start + insertStart.length, columnsEnd)
      .split(",")
      .map((column) => column.trim()),
    values: source.slice(columnsEnd + columnsEndMarker.length, statementEnd)
  };
}

class SourceContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceContractError";
  }
}
