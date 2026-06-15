import { describe, expect, it } from "vitest";

import { buildSecurityHeaders } from "./security-headers";

function headersFor(environment: "development" | "production"): Record<string, string> {
  return Object.fromEntries(buildSecurityHeaders(environment).map((header) => [header.key, header.value]));
}

describe("buildSecurityHeaders", () => {
  it("sets browser hardening headers", () => {
    const headers = headersFor("production");

    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });

  it("sets a CSP that blocks framing and keeps fonts self-hosted or data-only", () => {
    const headers = headersFor("production");

    expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).toContain("font-src 'self' data:");
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'self' https://iscience.riroschool.kr");
  });

  it("keeps Next dev tooling usable without weakening production script policy", () => {
    const developmentHeaders = headersFor("development");
    const productionHeaders = headersFor("production");

    expect(developmentHeaders["Content-Security-Policy"]).toContain("'unsafe-eval'");
    expect(productionHeaders["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
  });
});
