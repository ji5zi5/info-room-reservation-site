import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryRateLimitStore } from "./memory-rate-limit-store";
import { prismaRateLimitStore } from "./prisma-rate-limit-store";
import { rateLimitKey } from "./rate-limit";
import {
  buildAdminMutationRateLimitRules,
  buildLoginIdentifierRateLimitRules,
  buildLoginIpRateLimitRules,
  buildLoginRateLimitRules,
  buildReservationRateLimitRules,
  getRouteRateLimitStore
} from "./route-rate-limit";

describe("route rate-limit rules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds both login-specific and IP-only login buckets", () => {
    const rules = buildLoginRateLimitRules({ clientIp: "203.0.113.8", loginId: " StudentA " });

    expect(rules).toEqual([
      {
        key: rateLimitKey(["login", "minute", "203.0.113.8", "studenta"]),
        limit: 5,
        windowMs: 60_000
      },
      {
        key: rateLimitKey(["login", "hour", "203.0.113.8", "studenta"]),
        limit: 20,
        windowMs: 3_600_000
      },
      {
        key: rateLimitKey(["login-ip", "minute", "203.0.113.8"]),
        limit: 30,
        windowMs: 60_000
      },
      {
        key: rateLimitKey(["login-ip", "hour", "203.0.113.8"]),
        limit: 100,
        windowMs: 3_600_000
      }
    ]);
    for (const rule of rules) {
      expect(rule.key).not.toContain("StudentA");
      expect(rule.key).not.toContain("203.0.113.8");
    }
  });

  it("builds IP-only login buckets before a login id has been parsed", () => {
    const rules = buildLoginIpRateLimitRules({ clientIp: "203.0.113.8" });

    expect(rules).toEqual([
      {
        key: rateLimitKey(["login-ip", "minute", "203.0.113.8"]),
        limit: 30,
        windowMs: 60_000
      },
      {
        key: rateLimitKey(["login-ip", "hour", "203.0.113.8"]),
        limit: 100,
        windowMs: 3_600_000
      }
    ]);
    for (const rule of rules) {
      expect(rule.key).not.toContain("203.0.113.8");
    }
  });

  it("builds parsed login-id buckets without double-counting IP-only buckets", () => {
    const rules = buildLoginIdentifierRateLimitRules({ clientIp: "203.0.113.8", loginId: " StudentA " });

    expect(rules).toEqual([
      {
        key: rateLimitKey(["login", "minute", "203.0.113.8", "studenta"]),
        limit: 5,
        windowMs: 60_000
      },
      {
        key: rateLimitKey(["login", "hour", "203.0.113.8", "studenta"]),
        limit: 20,
        windowMs: 3_600_000
      }
    ]);
    for (const rule of rules) {
      expect(rule.key).not.toContain("StudentA");
      expect(rule.key).not.toContain("203.0.113.8");
    }
  });

  it("scopes reservation and admin mutation buckets to the authenticated user", () => {
    const reservationRules = buildReservationRateLimitRules({ clientIp: "203.0.113.8", userId: "user-1" });
    const adminRules = buildAdminMutationRateLimitRules({ adminId: "admin-1", clientIp: "203.0.113.8" });

    expect(reservationRules).toEqual([
      {
        key: rateLimitKey(["reservation", "minute", "203.0.113.8", "user-1"]),
        limit: 30,
        windowMs: 60_000
      }
    ]);
    expect(adminRules).toEqual([
      {
        key: rateLimitKey(["admin-mutation", "minute", "203.0.113.8", "admin-1"]),
        limit: 20,
        windowMs: 60_000
      }
    ]);
  });

  it("uses an in-memory store in no-database mock mode", () => {
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "");

    expect(getRouteRateLimitStore()).toBe(memoryRateLimitStore);
  });

  it("uses the Prisma store outside no-database mock mode", () => {
    vi.stubEnv("RIRO_MOCK_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@example.test:5432/info_room");

    expect(getRouteRateLimitStore()).toBe(prismaRateLimitStore);
  });
});
