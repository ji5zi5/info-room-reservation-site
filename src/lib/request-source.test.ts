import { describe, expect, it } from "vitest";

import { getRequestClientIp, hashClientIp, hashRequestClientIp } from "./request-source";

const hexSha256Pattern = /^[a-f0-9]{64}$/u;

describe("request source helpers", () => {
  it("uses the first non-empty forwarded-for IP before fallback headers", () => {
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

  it("hashes the normalized client IP without exposing the raw value", () => {
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
