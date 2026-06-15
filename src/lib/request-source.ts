import { createHash } from "node:crypto";

import { shouldTrustForwardedIpHeaders } from "./env";

const UNKNOWN_CLIENT_IP = "unknown";

export function getRequestClientIp(request: Request): string {
  if (!shouldTrustForwardedIpHeaders() || !isVercelRuntime()) {
    return UNKNOWN_CLIENT_IP;
  }

  const vercelForwardedIp = getFirstCommaSeparatedHeaderValue(request.headers, "x-vercel-forwarded-for");
  if (vercelForwardedIp) {
    return vercelForwardedIp;
  }

  const forwardedIp = getFirstCommaSeparatedHeaderValue(request.headers, "x-forwarded-for");
  if (forwardedIp) {
    return forwardedIp;
  }

  const realIp = getTrimmedHeaderValue(request.headers, "x-real-ip");
  if (realIp) {
    return realIp;
  }

  const connectingIp = getTrimmedHeaderValue(request.headers, "cf-connecting-ip");
  return connectingIp ?? UNKNOWN_CLIENT_IP;
}

export function hashRequestClientIp(request: Request): string {
  return hashClientIp(getRequestClientIp(request));
}

export function hashClientIp(clientIp: string): string {
  return createHash("sha256").update(normalizeClientIp(clientIp)).digest("hex");
}

function normalizeClientIp(clientIp: string): string {
  return clientIp.trim().toLowerCase();
}

function isVercelRuntime(): boolean {
  const vercelEnv = process.env.VERCEL_ENV?.trim();
  return process.env.VERCEL === "1" || (vercelEnv !== undefined && vercelEnv.length > 0);
}

function getFirstCommaSeparatedHeaderValue(headers: Headers, headerName: string): string | null {
  const headerValue = headers.get(headerName);
  if (headerValue === null) {
    return null;
  }

  return headerValue
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? null;
}

function getTrimmedHeaderValue(headers: Headers, headerName: string): string | null {
  const headerValue = headers.get(headerName)?.trim();
  return headerValue && headerValue.length > 0 ? headerValue : null;
}
