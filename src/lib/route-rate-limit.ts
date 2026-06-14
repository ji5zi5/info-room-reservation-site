import { memoryRateLimitStore } from "./memory-rate-limit-store";
import { isNoDatabaseMockMode } from "./mock-dev-mode";
import { prismaRateLimitStore } from "./prisma-rate-limit-store";
import { checkRateLimit, rateLimitKey } from "./rate-limit";
import type { RateLimitResult, RateLimitRule, RateLimitStore } from "./rate-limit";
import { getRequestClientIp } from "./request-source";

const LOGIN_MINUTE_LIMIT = 5;
const LOGIN_HOUR_LIMIT = 20;
const LOGIN_IP_MINUTE_LIMIT = 30;
const LOGIN_IP_HOUR_LIMIT = 100;
const RESERVATION_MINUTE_LIMIT = 30;
const ADMIN_MUTATION_MINUTE_LIMIT = 20;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

export function enforceLoginRateLimit(request: Request, loginId: string): Promise<RateLimitResult> {
  const clientIp = getRequestClientIp(request);
  return checkRateLimit({
    now: new Date(),
    rules: buildLoginRateLimitRules({ clientIp, loginId }),
    store: getRouteRateLimitStore()
  });
}

export function enforceReservationRateLimit(request: Request, userId: string): Promise<RateLimitResult> {
  const clientIp = getRequestClientIp(request);
  return checkRateLimit({
    now: new Date(),
    rules: buildReservationRateLimitRules({ clientIp, userId }),
    store: getRouteRateLimitStore()
  });
}

export function enforceAdminMutationRateLimit(request: Request, adminId: string): Promise<RateLimitResult> {
  const clientIp = getRequestClientIp(request);
  return checkRateLimit({
    now: new Date(),
    rules: buildAdminMutationRateLimitRules({ adminId, clientIp }),
    store: getRouteRateLimitStore()
  });
}

export function getRouteRateLimitStore(): RateLimitStore {
  return isNoDatabaseMockMode() ? memoryRateLimitStore : prismaRateLimitStore;
}

export function buildLoginRateLimitRules(input: {
  readonly clientIp: string;
  readonly loginId: string;
}): readonly RateLimitRule[] {
  const normalizedLoginId = normalizeRateLimitPart(input.loginId);
  return [
    {
      key: rateLimitKey(["login", "minute", input.clientIp, normalizedLoginId]),
      limit: LOGIN_MINUTE_LIMIT,
      windowMs: ONE_MINUTE_MS
    },
    {
      key: rateLimitKey(["login", "hour", input.clientIp, normalizedLoginId]),
      limit: LOGIN_HOUR_LIMIT,
      windowMs: ONE_HOUR_MS
    },
    {
      key: rateLimitKey(["login-ip", "minute", input.clientIp]),
      limit: LOGIN_IP_MINUTE_LIMIT,
      windowMs: ONE_MINUTE_MS
    },
    {
      key: rateLimitKey(["login-ip", "hour", input.clientIp]),
      limit: LOGIN_IP_HOUR_LIMIT,
      windowMs: ONE_HOUR_MS
    }
  ];
}

export function buildReservationRateLimitRules(input: {
  readonly clientIp: string;
  readonly userId: string;
}): readonly RateLimitRule[] {
  return [
    {
      key: rateLimitKey(["reservation", "minute", input.clientIp, input.userId]),
      limit: RESERVATION_MINUTE_LIMIT,
      windowMs: ONE_MINUTE_MS
    }
  ];
}

export function buildAdminMutationRateLimitRules(input: {
  readonly adminId: string;
  readonly clientIp: string;
}): readonly RateLimitRule[] {
  return [
    {
      key: rateLimitKey(["admin-mutation", "minute", input.clientIp, input.adminId]),
      limit: ADMIN_MUTATION_MINUTE_LIMIT,
      windowMs: ONE_MINUTE_MS
    }
  ];
}

function normalizeRateLimitPart(value: string): string {
  return value.trim().toLowerCase();
}
