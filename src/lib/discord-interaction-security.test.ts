import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  readBoundedRawRequestBody,
  verifyDiscordInteractionRequest,
  verifyDiscordInteractionSignature
} from "./discord-interaction-security";

const NOW_MS = 1_700_000_000_000;
const TIMESTAMP = String(NOW_MS / 1_000);
const keyPair = generateKeyPairSync("ed25519");
const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
const publicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32).toString("hex");

function signatureFor(body: Uint8Array, timestamp = TIMESTAMP): string {
  return sign(null, Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body)]), keyPair.privateKey).toString("hex");
}

function signedRequest(body: Uint8Array, input: { readonly signature?: string; readonly timestamp?: string } = {}): Request {
  const requestBody = new Uint8Array(body.byteLength);
  requestBody.set(body);

  return new Request("https://example.test/api/discord/interactions", {
    body: requestBody.buffer,
    headers: {
      ...(input.signature === undefined ? { "x-signature-ed25519": signatureFor(body, input.timestamp ?? TIMESTAMP) } : { "x-signature-ed25519": input.signature }),
      ...(input.timestamp === undefined ? { "x-signature-timestamp": TIMESTAMP } : { "x-signature-timestamp": input.timestamp })
    },
    method: "POST"
  });
}

describe("Discord interaction signature verification", () => {
  it("accepts a generated Ed25519 signature over the timestamp bytes and untouched raw body", async () => {
    // Given
    const rawBody = new Uint8Array([0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x31, 0x7d, 0xff]);
    const request = signedRequest(rawBody);

    // When
    const result = await verifyDiscordInteractionRequest(request, publicKey, { nowMs: NOW_MS });

    // Then
    expect(result).toEqual({ body: rawBody, kind: "accepted" });
  });

  it("rejects a valid signature when even one raw request byte is tampered", () => {
    // Given
    const originalBody = new TextEncoder().encode('{"type":1}');
    const tamperedBody = new TextEncoder().encode('{"type":2}');

    // When
    const accepted = verifyDiscordInteractionSignature({
      body: tamperedBody,
      nowMs: NOW_MS,
      publicKey,
      signature: signatureFor(originalBody),
      timestamp: TIMESTAMP
    });

    // Then
    expect(accepted).toBe(false);
  });

  it("fails closed for stale, malformed, and missing signature headers", async () => {
    // Given
    const body = new TextEncoder().encode('{"type":1}');
    const staleTimestamp = String(NOW_MS / 1_000 - 301);

    // When
    const stale = verifyDiscordInteractionSignature({
      body,
      nowMs: NOW_MS,
      publicKey,
      signature: signatureFor(body, staleTimestamp),
      timestamp: staleTimestamp
    });
    const malformed = verifyDiscordInteractionSignature({
      body,
      nowMs: NOW_MS,
      publicKey,
      signature: "not-hex",
      timestamp: "not-a-timestamp"
    });
    const missingSignature = await verifyDiscordInteractionRequest(
      signedRequest(body, { signature: "" }),
      publicKey,
      { nowMs: NOW_MS }
    );
    const missingTimestamp = await verifyDiscordInteractionRequest(
      signedRequest(body, { timestamp: "" }),
      publicKey,
      { nowMs: NOW_MS }
    );

    // Then
    expect(stale).toBe(false);
    expect(malformed).toBe(false);
    expect(missingSignature).toEqual({ kind: "rejected" });
    expect(missingTimestamp).toEqual({ kind: "rejected" });
  });

  it("rejects oversized raw bodies before signature verification", async () => {
    // Given
    const body = new TextEncoder().encode('{"type":1}');
    const request = signedRequest(body);

    // When
    const bodyResult = await readBoundedRawRequestBody(request, 4);
    const result = await verifyDiscordInteractionRequest(signedRequest(body), publicKey, { maxBytes: 4, nowMs: NOW_MS });

    // Then
    expect(bodyResult).toEqual({ kind: "too_large" });
    expect(result).toEqual({ kind: "rejected" });
  });
});
