import { afterEach, describe, expect, it, vi } from "vitest";

import { getRequestClientIp, hashClientIp, hashRequestClientIp } from "./request-source";

const hexSha256Pattern = /^[a-f0-9]{64}$/u;

describe("request source helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function trustForwardedHeadersOnVercel(): void {
    vi.stubEnv("TRUST_FORWARDED_IP_HEADERS", "true");
    vi.stubEnv("VERCEL", "1");
  }

  it("uses unknown for bare spoofed forwarded-for headers without trusted proxy policy", () => {
    vi.stubEnv("TRUST_FORWARDED_IP_HEADERS", "false");

    const firstRequest = new Request("https://example.test", {
      headers: { "x-forwarded-for": "203.0.113.8" }
    });
    const secondRequest = new Request("https://example.test", {
      headers: { "x-forwarded-for": "198.51.100.10" }
    });

    expect(getRequestClientIp(firstRequest)).toBe("unknown");
    expect(getRequestClientIp(secondRequest)).toBe("unknown");
  });

  it("uses unknown for trusted proxy headers without a Vercel runtime signal", () => {
    vi.stubEnv("TRUST_FORWARDED_IP_HEADERS", "true");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("VERCEL_ENV", "");

    const request = new Request("https://example.test", {
      headers: {
        "cf-connecting-ip": "198.51.100.44",
        "x-forwarded-for": "203.0.113.8",
        "x-real-ip": "198.51.100.10"
      }
    });

    expect(getRequestClientIp(request)).toBe("unknown");
  });

  it("prefers the first non-empty Vercel forwarded-for IP under trusted Vercel proxy policy", () => {
    trustForwardedHeadersOnVercel();

    const request = new Request("https://example.test", {
      headers: {
        "x-forwarded-for": "198.51.100.10",
        "x-real-ip": "198.51.100.11",
        "x-vercel-forwarded-for": " , 203.0.113.8 , 203.0.113.9"
      }
    });

    expect(getRequestClientIp(request)).toBe("203.0.113.8");
  });

  it("uses the first non-empty forwarded-for IP under trusted Vercel proxy policy before fallback headers", () => {
    trustForwardedHeadersOnVercel();

    const request = new Request("https://example.test", {
      headers: {
        "cf-connecting-ip": "198.51.100.44",
        "x-forwarded-for": " , 203.0.113.8 , 203.0.113.9",
        "x-real-ip": "198.51.100.10"
      }
    });

    expect(getRequestClientIp(request)).toBe("203.0.113.8");
  });

  it("falls back to real-ip, cloudflare IP, then unknown", () => {
    trustForwardedHeadersOnVercel();

    const realIpRequest = new Request("https://example.test", {
      headers: { "x-real-ip": " 198.51.100.10 " }
    });
    const cloudflareRequest = new Request("https://example.test", {
      headers: { "cf-connecting-ip": " 198.51.100.44 " }
    });
    const unknownRequest = new Request("https://example.test");

    expect(getRequestClientIp(realIpRequest)).toBe("198.51.100.10");
    expect(getRequestClientIp(cloudflareRequest)).toBe("198.51.100.44");
    expect(getRequestClientIp(unknownRequest)).toBe("unknown");
  });

  it("uses unknown for empty trusted proxy header values", () => {
    trustForwardedHeadersOnVercel();

    const request = new Request("https://example.test", {
      headers: {
        "cf-connecting-ip": " ",
        "x-forwarded-for": " , , ",
        "x-real-ip": " "
      }
    });

    expect(getRequestClientIp(request)).toBe("unknown");
  });

  it("hashes the normalized client IP without exposing the raw value", () => {
    trustForwardedHeadersOnVercel();

    const request = new Request("https://example.test", {
      headers: { "x-forwarded-for": " ADMIN-LAB-IP " }
    });

    const directHash = hashClientIp("admin-lab-ip");
    const requestHash = hashRequestClientIp(request);

    expect(requestHash).toBe(directHash);
    expect(requestHash).toMatch(hexSha256Pattern);
    expect(requestHash).not.toContain("admin-lab-ip");
    expect(hashClientIp(" ADMIN-LAB-IP ")).toBe(directHash);
  });
});
