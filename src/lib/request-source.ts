import { createHash } from "node:crypto";

import { shouldTrustForwardedIpHeaders } from "./env";

const UNKNOWN_CLIENT_IP = "unknown";

export function getRequestClientIp(request: Request): string {
  if (!shouldTrustForwardedIpHeaders()) {
    return UNKNOWN_CLIENT_IP;
  }

  const forwardedIp = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (forwardedIp) {
    return forwardedIp;
  }

  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  const connectingIp = request.headers.get("cf-connecting-ip")?.trim();
  return connectingIp && connectingIp.length > 0 ? connectingIp : UNKNOWN_CLIENT_IP;
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
