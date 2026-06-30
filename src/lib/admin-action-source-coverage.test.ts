import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const auditedRouteFiles = [
  "src/app/api/admin/notification-settings/route.ts",
  "src/app/api/admin/notifications/closed-periods/send/route.ts",
  "src/app/api/admin/period-settings/route.ts",
  "src/app/api/admin/reservations/[id]/cancel/route.ts",
  "src/app/api/admin/reservations/[id]/no-show/route.ts",
  "src/app/api/admin/users/[id]/restriction/route.ts",
  "src/app/api/admin/users/[id]/sessions/revoke/route.ts",
  "src/app/api/reservations/[id]/route.ts"
] as const;

describe("admin action source coverage", () => {
  it("records hashed request source for every route-level admin action write", () => {
    for (const filePath of auditedRouteFiles) {
      const source = readFileSync(join(process.cwd(), filePath), "utf8");

      expect(source, `${filePath} should create an AdminAction`).toContain("adminAction.create");
      expect(source, `${filePath} should compute hashed request source`).toContain("hashRequestClientIp(request)");
      expect(source, `${filePath} should persist AdminAction.ipHash`).toContain("ipHash");
    }
  });
});
