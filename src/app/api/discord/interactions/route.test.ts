import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISCORD_INTERACTION_MAX_BODY_BYTES } from "@/lib/discord-interaction-security";

const NOW_MS = 1_800_000_000_000;
const TIMESTAMP = String(NOW_MS / 1_000);
const keyPair = generateKeyPairSync("ed25519");
const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
const publicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32).toString("hex");

const nextServerMocks = vi.hoisted(
  (): { callback: (() => Promise<void> | void) | undefined } => ({ callback: undefined })
);
const handlerMocks = vi.hoisted(() => ({
  authorizeRejectComponent: vi.fn(),
  runDeferredDiscordReservationInteraction: vi.fn()
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((callback: () => Promise<void> | void) => {
    nextServerMocks.callback = callback;
  })
}));

vi.mock("@/lib/discord-interaction-handler", () => ({
  authorizeRejectComponent: handlerMocks.authorizeRejectComponent,
  runDeferredDiscordReservationInteraction: handlerMocks.runDeferredDiscordReservationInteraction
}));

import { POST, runtime } from "./route";

const ids = {
  application: "123456789012345678",
  channel: "223456789012345678",
  guild: "323456789012345678",
  interaction: "423456789012345678",
  message: "523456789012345678",
  role: "623456789012345678",
  user: "723456789012345678"
} as const;

describe("Discord interaction HTTP route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    nextServerMocks.callback = undefined;
    vi.stubEnv("DISCORD_APPLICATION_ID", ids.application);
    vi.stubEnv("DISCORD_PUBLIC_KEY", publicKey);
    vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
    vi.stubEnv("DISCORD_GUILD_ID", ids.guild);
    vi.stubEnv("DISCORD_CHANNEL_ID", ids.channel);
    vi.stubEnv("DISCORD_ADMIN_ROLE_ID", ids.role);
    vi.stubEnv("DISCORD_ADMIN_USER_MAP", `${ids.user}:31001`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a DB-free PONG for a valid signed PING", async () => {
    // Given
    const request = signedJsonRequest({ application_id: ids.application, type: 1 });

    // When
    const response = await POST(request);

    // Then
    expect(runtime).toBe("nodejs");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
    expect(handlerMocks.authorizeRejectComponent).not.toHaveBeenCalled();
    expect(handlerMocks.runDeferredDiscordReservationInteraction).not.toHaveBeenCalled();
    expect(nextServerMocks.callback).toBeUndefined();
  });

  it.each([
    ["tampered", () => signedRequest('{"application_id":"123456789012345678","type":2}', { signedBody: '{"application_id":"123456789012345678","type":1}' })],
    ["stale", () => signedRequest('{"application_id":"123456789012345678","type":1}', { timestamp: String(Number(TIMESTAMP) - 301) })],
    ["oversized", () => signedRequest("x".repeat(DISCORD_INTERACTION_MAX_BODY_BYTES + 1))],
    ["missing signature", () => new Request("https://example.test/api/discord/interactions", { body: "{}", method: "POST" })]
  ])("returns 401 before parsing or DB for a %s request", async (_scenario, requestFactory) => {
    // Given
    const request = requestFactory();

    // When
    const response = await POST(request);

    // Then
    expect(response.status).toBe(401);
    expect(handlerMocks.authorizeRejectComponent).not.toHaveBeenCalled();
    expect(handlerMocks.runDeferredDiscordReservationInteraction).not.toHaveBeenCalled();
  });

  it("returns 400 for signed malformed JSON", async () => {
    // Given
    const request = signedRequest("{");

    // When
    const response = await POST(request);

    // Then
    expect(response.status).toBe(400);
    expect(handlerMocks.authorizeRejectComponent).not.toHaveBeenCalled();
  });

  it("returns an immediate generic 400 for a signed unsupported payload", async () => {
    // Given
    const request = signedJsonRequest({ application_id: ids.application, type: 2 });

    // When
    const response = await POST(request);

    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ data: { flags: 64 }, type: 4 });
    expect(handlerMocks.authorizeRejectComponent).not.toHaveBeenCalled();
  });

  it("returns a reason modal after authorizing a reject component", async () => {
    // Given
    handlerMocks.authorizeRejectComponent.mockResolvedValue({ kind: "authorized", reservationId: "reservation-1" });

    // When
    const response = await POST(signedJsonRequest(componentPayload("reservation:reject:reservation-1")));

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { custom_id: "reservation:reject:reservation-1" }, type: 9 });
    expect(handlerMocks.runDeferredDiscordReservationInteraction).not.toHaveBeenCalled();
  });

  it("returns a generic immediate error when a reject component is unauthorized", async () => {
    // Given
    handlerMocks.authorizeRejectComponent.mockResolvedValue({ kind: "rejected" });

    // When
    const response = await POST(signedJsonRequest(componentPayload("reservation:reject:reservation-1")));

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { flags: 64 }, type: 4 });
  });

  it.each([
    ["accept component", componentPayload("reservation:accept:reservation-1")],
    ["reject modal", modalPayload()]
  ])("defers a valid %s before DB work and completes it through after()", async (_scenario, payload) => {
    // Given
    let releaseWork: (() => void) | undefined;
    handlerMocks.runDeferredDiscordReservationInteraction.mockImplementation(
      () => new Promise<void>((resolve) => { releaseWork = resolve; })
    );

    // When
    const startedAt = performance.now();
    const response = await POST(signedJsonRequest(payload));
    const elapsedMs = performance.now() - startedAt;

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { flags: 64 }, type: 5 });
    expect(elapsedMs).toBeLessThan(250);
    expect(elapsedMs).toBeLessThan(3_000);
    expect(handlerMocks.runDeferredDiscordReservationInteraction).not.toHaveBeenCalled();
    expect(nextServerMocks.callback).toBeTypeOf("function");
    const completion = nextServerMocks.callback?.();
    expect(handlerMocks.runDeferredDiscordReservationInteraction).toHaveBeenCalledOnce();
    releaseWork?.();
    await completion;
  });

  it("returns a redacted service-unavailable response when app config is missing", async () => {
    // Given
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    // When
    const response = await POST(signedJsonRequest({ application_id: ids.application, type: 1 }));
    const body = await response.text();

    // Then
    expect(response.status).toBe(503);
    expect(body).not.toContain("DISCORD_BOT_TOKEN");
    expect(body).not.toContain("bot-token");
  });
});

function componentPayload(customId: string) {
  return {
    application_id: ids.application, channel_id: ids.channel,
    data: { component_type: 2, custom_id: customId }, guild_id: ids.guild, id: ids.interaction,
    member: { roles: [ids.role], user: { id: ids.user } }, message: { id: ids.message }, token: "interaction-token", type: 3
  };
}

function modalPayload() {
  return {
    ...componentPayload("reservation:reject:reservation-1"),
    data: { components: [{ components: [{ custom_id: "reason", type: 4, value: "행사 준비" }], type: 1 }], custom_id: "reservation:reject:reservation-1" },
    type: 5
  };
}

function signedJsonRequest(payload: unknown): Request {
  return signedRequest(JSON.stringify(payload));
}

function signedRequest(body: string, input: { readonly signedBody?: string; readonly timestamp?: string } = {}): Request {
  const timestamp = input.timestamp ?? TIMESTAMP;
  const signedBody = input.signedBody ?? body;
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(signedBody)]), keyPair.privateKey).toString("hex");
  return new Request("https://example.test/api/discord/interactions", {
    body,
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    method: "POST"
  });
}
