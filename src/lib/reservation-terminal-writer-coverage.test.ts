import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const TERMINAL_TRIGGER_MIGRATION = "prisma/migrations/20260811010000_add_discord_reservation_operations/migration.sql";

const REAL_TERMINAL_WRITERS = [
  {
    file: "src/lib/admin-reservation-operations.ts",
    markers: ["status: \"CANCELLED\"", "status: \"CONFIRMED\""]
  },
  {
    file: "src/app/api/admin/reservations/[id]/no-show/route.ts",
    markers: ["status: \"NO_SHOW\"", "status: \"CANCELLED\""]
  },
  {
    file: "src/app/api/admin/users/[id]/restriction/route.ts",
    markers: ["status: \"CANCELLED\""]
  },
  {
    file: "prisma/migrations/20260810020000_add_owned_student_cancellation_capability/migration.sql",
    markers: [
      "app_private.cancel_owned_student_reservation",
      "SET \"status\" = 'CANCELLED'",
      "IF user_booking_status IS DISTINCT FROM 'SHADOW_BANNED' THEN"
    ]
  }
] as const;

describe("reservation terminal writer coverage", () => {
  it("pins every real CONFIRMED to CANCELLED or NO_SHOW writer behind the reservation status trigger", () => {
    // Given
    const migration = source(TERMINAL_TRIGGER_MIGRATION);

    // When
    const writerSources = REAL_TERMINAL_WRITERS.map(({ file, markers }) => ({
      file,
      missingMarkers: markers.filter((marker) => !source(file).includes(marker))
    }));
    const discoveredWriters = [
      ...typescriptSources(join(process.cwd(), "src"))
        .filter((file) => !file.endsWith(".test.ts") && !file.includes("mock-"))
        .filter((file) => /data:\s*\{\s*status:\s*"(?:CANCELLED|NO_SHOW)"/u.test(readFileSync(file, "utf8"))),
      ...migrationSources().filter((file) =>
        /UPDATE\s+"public"\."Reservation"[\s\S]{0,300}SET\s+"status"\s*=\s*'(?:CANCELLED|NO_SHOW)'/u.test(
          readFileSync(file, "utf8")
        )
      )
    ].map(repoRelative).sort();

    // Then
    expect(writerSources).toEqual(REAL_TERMINAL_WRITERS.map(({ file }) => ({ file, missingMarkers: [] })));
    expect(discoveredWriters).toEqual(REAL_TERMINAL_WRITERS.map(({ file }) => file).sort());
    expect(migration).toContain("AFTER UPDATE OF \"status\" ON \"Reservation\"");
    expect(migration).toContain("NEW.\"status\" IN ('CANCELLED', 'NO_SHOW')");
    expect(migration).toContain("UPDATE \"public\".\"DiscordReservationMessage\"");
    expect(migration).toContain("SECURITY DEFINER");
  });
});

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function migrationSources(): readonly string[] {
  return readdirSync(join(process.cwd(), "prisma/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(process.cwd(), "prisma/migrations", entry.name, "migration.sql"));
}

function typescriptSources(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptSources(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function repoRelative(path: string): string {
  return relative(process.cwd(), path).replaceAll("\\", "/");
}
