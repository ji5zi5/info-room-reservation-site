export type RuntimeEnvironment = "development" | "production" | "test";

export type SecurityHeader = {
  readonly key: string;
  readonly value: string;
};

export function buildSecurityHeaders(environment: RuntimeEnvironment = runtimeEnvironment()): readonly SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "Content-Security-Policy", value: buildContentSecurityPolicy(environment) },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
    { key: "X-Frame-Options", value: "DENY" }
  ];

  if (environment === "production") {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
  }

  return headers;
}

function buildContentSecurityPolicy(environment: RuntimeEnvironment): string {
  const scriptSrc = environment === "development" ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://iscience.riroschool.kr",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ];

  if (environment === "production") {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

function runtimeEnvironment(): RuntimeEnvironment {
  if (process.env.NODE_ENV === "production") {
    return "production";
  }
  if (process.env.NODE_ENV === "test") {
    return "test";
  }
  return "development";
}
