import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";

const DISCORD_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DISCORD_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/iu;
const DISCORD_SIGNATURE_PATTERN = /^[0-9a-f]{128}$/iu;
const DISCORD_TIMESTAMP_PATTERN = /^\d{10}$/u;

export const DISCORD_INTERACTION_MAX_BODY_BYTES = 64 * 1024;
export const DISCORD_INTERACTION_REPLAY_WINDOW_MS = 5 * 60 * 1_000;

export type BoundedRawRequestBodyResult =
  | { readonly body: Uint8Array; readonly kind: "ok" }
  | { readonly kind: "too_large" };

export type DiscordInteractionVerificationResult =
  | { readonly body: Uint8Array; readonly kind: "accepted" }
  | { readonly kind: "rejected" };

export async function verifyDiscordInteractionRequest(
  request: Request,
  publicKey: string,
  input: { readonly maxBytes?: number; readonly nowMs?: number } = {}
): Promise<DiscordInteractionVerificationResult> {
  const bodyResult = await readBoundedRawRequestBody(request, input.maxBytes ?? DISCORD_INTERACTION_MAX_BODY_BYTES);
  if (bodyResult.kind !== "ok") {
    return { kind: "rejected" };
  }

  const accepted = verifyDiscordInteractionSignature({
    body: bodyResult.body,
    nowMs: input.nowMs ?? Date.now(),
    publicKey,
    signature: request.headers.get("x-signature-ed25519"),
    timestamp: request.headers.get("x-signature-timestamp")
  });
  return accepted ? { body: bodyResult.body, kind: "accepted" } : { kind: "rejected" };
}

export function verifyDiscordInteractionSignature(input: {
  readonly body: Uint8Array;
  readonly nowMs: number;
  readonly publicKey: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
}): boolean {
  if (
    input.body.byteLength === 0 ||
    input.signature === null ||
    input.timestamp === null ||
    !DISCORD_PUBLIC_KEY_PATTERN.test(input.publicKey) ||
    !DISCORD_SIGNATURE_PATTERN.test(input.signature) ||
    !isTimestampWithinReplayWindow(input.timestamp, input.nowMs)
  ) {
    return false;
  }

  const publicKeyDer = Buffer.concat([DISCORD_ED25519_SPKI_PREFIX, Buffer.from(input.publicKey, "hex")]);
  const signedData = Buffer.concat([Buffer.from(input.timestamp, "utf8"), Buffer.from(input.body)]);
  const signature = Buffer.from(input.signature, "hex");
  const key = createPublicKey({ format: "der", key: publicKeyDer, type: "spki" });
  return verify(null, signedData, key, signature);
}

export async function readBoundedRawRequestBody(
  request: Request,
  maxBytes = DISCORD_INTERACTION_MAX_BODY_BYTES
): Promise<BoundedRawRequestBodyResult> {
  if (!request.body || maxBytes < 1) {
    return { kind: "too_large" };
  }

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && isDeclaredLengthTooLarge(declaredLength, maxBytes)) {
    return { kind: "too_large" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      const body = new Uint8Array(bytesRead);
      let offset = 0;
      for (const value of chunks) {
        body.set(value, offset);
        offset += value.byteLength;
      }
      return { body, kind: "ok" };
    }

    bytesRead += chunk.value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return { kind: "too_large" };
    }
    chunks.push(chunk.value);
  }
}

function isTimestampWithinReplayWindow(timestamp: string, nowMs: number): boolean {
  if (!DISCORD_TIMESTAMP_PATTERN.test(timestamp) || !Number.isFinite(nowMs)) {
    return false;
  }

  const timestampMs = Number(timestamp) * 1_000;
  return Math.abs(nowMs - timestampMs) <= DISCORD_INTERACTION_REPLAY_WINDOW_MS;
}

function isDeclaredLengthTooLarge(value: string, maxBytes: number): boolean {
  if (!/^\d+$/u.test(value)) {
    return false;
  }
  return Number(value) > maxBytes;
}
