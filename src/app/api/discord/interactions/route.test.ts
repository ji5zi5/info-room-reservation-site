import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";

import { buildDiscordReservationCustomId } from "@/lib/discord-interactions";
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
  acknowledgeDiscordReservationInteraction: vi.fn(),
  authorizeDiscordInteractionModal: vi.fn(),
  runExactPendingDiscordInteraction: vi.fn()
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn((callback: () => Promise<void> | void) => { nextServerMocks.callback = callback; })
}));

vi.mock("@/lib/discord-interaction-handler", () => handlerMocks);

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
    handlerMocks.acknowledgeDiscordReservationInteraction.mockResolvedValue({ kind: "acknowledged" });
    handlerMocks.authorizeDiscordInteractionModal.mockResolvedValue({ kind: "authorized" });
    handlerMocks.runExactPendingDiscordInteraction.mockResolvedValue(undefined);
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
    expect(handlerMocks.acknowledgeDiscordReservationInteraction).not.toHaveBeenCalled();
    expect(handlerMocks.authorizeDiscordInteractionModal).not.toHaveBeenCalled();
    expect(nextServerMocks.callback).toBeUndefined();
  });

  it.each([
    ["tampered", () => signedRequest('{"application_id":"123456789012345678","type":2}', { signedBody: '{"application_id":"123456789012345678","type":1}' })],
    ["stale", () => signedRequest('{"application_id":"123456789012345678","type":1}', { timestamp: String(Number(TIMESTAMP) - 301) })],
    ["oversized", () => signedRequest("x".repeat(DISCORD_INTERACTION_MAX_BODY_BYTES + 1))],
    ["missing signature", () => new Request("https://example.test/api/discord/interactions", { body: "{}", method: "POST" })]
  ])("fails closed before parsing or persistence for a %s request", async (_scenario, requestFactory) => {
    // Given / When
    const response = await POST(requestFactory());

    // Then
    expect(response.status).toBe(401);
    expect(handlerMocks.acknowledgeDiscordReservationInteraction).not.toHaveBeenCalled();
    expect(nextServerMocks.callback).toBeUndefined();
  });

  it("returns 400 for signed malformed JSON", async () => {
    // Given / When
    const response = await POST(signedRequest("{"));

    // Then
    expect(response.status).toBe(400);
    expect(handlerMocks.acknowledgeDiscordReservationInteraction).not.toHaveBeenCalled();
  });

  it.each(["reject", "admin_cancel", "no_show"] as const)(
    "returns the Todo 9 modal only after authorizing a %s click",
    async (action) => {
      // Given
      const customId = customIdFor(action);

      // When
      const response = await POST(signedJsonRequest(componentPayload(customId)));

      // Then
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { custom_id: customId }, type: 9 });
      expect(handlerMocks.authorizeDiscordInteractionModal).toHaveBeenCalledOnce();
      expect(handlerMocks.acknowledgeDiscordReservationInteraction).not.toHaveBeenCalled();
      expect(nextServerMocks.callback).toBeUndefined();
    }
  );

  it("returns a generic immediate error for an unauthorized modal click", async () => {
    // Given
    handlerMocks.authorizeDiscordInteractionModal.mockResolvedValue({ kind: "rejected" });

    // When
    const response = await POST(signedJsonRequest(componentPayload(customIdFor("reject"))));

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { flags: 64 }, type: 4 });
    expect(nextServerMocks.callback).toBeUndefined();
  });

  it.each([
    ["accept component", componentPayload(customIdFor("accept"))],
    ["reject modal", modalPayload("reject")],
    ["administrator cancellation modal", modalPayload("admin_cancel")]
  ])("returns type 5 only after a durable %s acknowledgement and runs that exact job after the response", async (_scenario, payload) => {
    // Given
    let durable = false;
    handlerMocks.acknowledgeDiscordReservationInteraction.mockImplementation(async () => {
      durable = true;
      return { kind: "acknowledged" };
    });

    // When
    const response = await POST(signedJsonRequest(payload));

    // Then
    expect(durable).toBe(true);
    expect(await response.json()).toEqual({ data: { flags: 64 }, type: 5 });
    expect(nextServerMocks.callback).toBeTypeOf("function");
    expect(handlerMocks.runExactPendingDiscordInteraction).not.toHaveBeenCalled();
    await nextServerMocks.callback?.();
    expect(handlerMocks.runExactPendingDiscordInteraction).toHaveBeenCalledWith(expect.objectContaining({
      interactionId: ids.interaction,
      interactionToken: "interaction-token"
    }));
  });

  it("returns only the generic error and schedules no after work when staging times out or fails", async () => {
    // Given
    handlerMocks.acknowledgeDiscordReservationInteraction.mockResolvedValue({ kind: "rejected" });

    // When
    const response = await POST(signedJsonRequest(componentPayload(customIdFor("accept"))));

    // Then
    expect(await response.json()).toMatchObject({ data: { flags: 64 }, type: 4 });
    expect(nextServerMocks.callback).toBeUndefined();
    expect(handlerMocks.runExactPendingDiscordInteraction).not.toHaveBeenCalled();
  });

  it.runIf(Boolean(process.env.INTEGRATION_DATABASE_URL))(
    "runs cold, 100-request, timeout-abandonment, and activation-won signed routes through real Prisma",
    async () => {
      // Given: migrated disposable PostgreSQL and only external Discord context represented by fixture rows.
      const database = new PrismaClient();
      const realHandler = await vi.importActual<typeof import("@/lib/discord-interaction-handler")>(
        "@/lib/discord-interaction-handler"
      );
      const realStore = await vi.importActual<typeof import("@/lib/prisma-discord-interaction-job-store")>(
        "@/lib/prisma-discord-interaction-job-store"
      );
      handlerMocks.acknowledgeDiscordReservationInteraction.mockImplementation(
        realHandler.acknowledgeDiscordReservationInteraction
      );
      const timeoutId = "423456789012349900";
      const activationWonId = "423456789012349901";
      const normalIds = Array.from(
        { length: 100 },
        (_, index) => String(423_456_789_012_340_000n + BigInt(index))
      );
      const server = createServer(async (incoming, outgoing) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value !== undefined) {
            headers.set(name, value);
          }
        }
        const response = await POST(new Request("http://127.0.0.1/api/discord/interactions", {
          body: Buffer.concat(chunks), headers, method: "POST"
        }));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      });
      const elapsed: number[] = [];

      try {
        await database.discordInteractionJob.deleteMany({
          where: { interactionId: { in: [...normalIds, timeoutId, activationWonId] } }
        });
        await database.discordReservationMessage.deleteMany({ where: { reservationId: "reservation-1" } });
        await database.reservation.deleteMany({ where: { id: "reservation-1" } });
        await database.user.deleteMany({ where: { studentNumber: "31001" } });
        const admin = await database.user.create({
          data: { generation: 31, id: "todo8-admin", name: "Todo8 Admin", role: "ADMIN", studentNumber: "31001" }
        });
        await database.reservation.create({
          data: {
            date: "2026-08-13", id: "reservation-1", reason: "fixture", studyPeriod: "EIGHTH", userId: admin.id
          }
        });
        await database.discordReservationMessage.create({
          data: {
            channelId: ids.channel, guildId: ids.guild, initialSendStatus: "SENT", messageId: ids.message,
            nonce: "source-message-1", renderedSourceEpoch: 7, reservationId: "reservation-1"
          }
        });
        await database.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION todo8_stage_delay() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW."interactionId" IN ('${timeoutId}', '${activationWonId}') THEN
              PERFORM pg_sleep(0.65);
            END IF;
            RETURN NEW;
          END $$
        `);
        await database.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION todo8_activation_delay() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW."handshakeStatus" = 'ACKNOWLEDGED' AND OLD."handshakeStatus" = 'STAGED' THEN
              IF NEW."interactionId" = '${timeoutId}' THEN PERFORM pg_sleep(1.0); END IF;
              IF NEW."interactionId" = '${activationWonId}' THEN PERFORM pg_sleep(0.65); END IF;
            END IF;
            RETURN NEW;
          END $$
        `);
        await database.$executeRawUnsafe(`
          CREATE TRIGGER todo8_stage_delay BEFORE INSERT ON "DiscordInteractionJob"
            FOR EACH ROW EXECUTE FUNCTION todo8_stage_delay()
        `);
        await database.$executeRawUnsafe(`
          CREATE TRIGGER todo8_activation_delay BEFORE UPDATE ON "DiscordInteractionJob"
            FOR EACH ROW EXECUTE FUNCTION todo8_activation_delay()
        `);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string") throw new TypeError("Loopback server did not bind a TCP port");

        // When: the first request is cold, 100 requests traverse the signed route/store, then both deadline races run.
        for (const interactionId of normalIds) {
          const body = JSON.stringify(componentPayload(customIdFor("accept"), interactionId));
          const startedAt = performance.now();
          const response = await fetch(`http://127.0.0.1:${address.port}/api/discord/interactions`, signedFetchInit(body));
          elapsed.push(performance.now() - startedAt);
          expect(await response.json()).toEqual({ data: { flags: 64 }, type: 5 });
        }
        nextServerMocks.callback = undefined;
        for (const [interactionId, expectedType] of [[timeoutId, 4], [activationWonId, 5]] as const) {
          const body = JSON.stringify(componentPayload(customIdFor("accept"), interactionId));
          const startedAt = performance.now();
          const response = await fetch(`http://127.0.0.1:${address.port}/api/discord/interactions`, signedFetchInit(body));
          elapsed.push(performance.now() - startedAt);
          expect((await response.json()).type).toBe(expectedType);
          if (expectedType === 4) expect(nextServerMocks.callback).toBeUndefined();
        }

        // Then: every response is bounded and exact durable rows identify the race winner.
        const rows = await database.discordInteractionJob.findMany({
          select: {
            commandDigest: true, handshakeStatus: true, intent: true, interactionId: true, ipHash: true, status: true
          },
          where: { interactionId: { in: [...normalIds, timeoutId, activationWonId] } }
        });
        const maximumMs = Math.max(...elapsed);
        console.warn(
          `REAL_PRISMA_SIGNED_REQUESTS=${elapsed.length} COLD_MS=${elapsed[0]?.toFixed(3)} MAXIMUM_MS=${maximumMs.toFixed(3)}`
        );
        expect(elapsed).toHaveLength(102);
        expect(elapsed.every((value) => value < 2_500)).toBe(true);
        expect(rows).toHaveLength(102);
        expect(rows.filter(({ interactionId }) => normalIds.includes(interactionId)).every(
          ({ handshakeStatus, status }) => handshakeStatus === "ACKNOWLEDGED" && status === "PENDING"
        )).toBe(true);
        expect(rows.find(({ interactionId }) => interactionId === timeoutId)).toMatchObject({
          handshakeStatus: "ABANDONED_UNACKED", status: "ABANDONED"
        });
        expect(rows.find(({ interactionId }) => interactionId === activationWonId)).toMatchObject({
          handshakeStatus: "ACKNOWLEDGED", status: "PENDING"
        });
        expect(JSON.stringify(rows)).not.toContain("interaction-token");

        const blocker = new Client({ connectionString: process.env.INTEGRATION_DATABASE_URL });
        await blocker.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query('LOCK TABLE "DiscordInteractionJob" IN ACCESS EXCLUSIVE MODE');
          const outageStartedAt = performance.now();
          await expect(realStore.settleDiscordInteractionHandshake({
            commandDigest: rows[0]?.commandDigest ?? "",
            interactionId: rows[0]?.interactionId ?? ""
          })).rejects.toBeInstanceOf(Error);
          const outageElapsedMs = performance.now() - outageStartedAt;
          console.warn(`REAL_PRISMA_BOUNDED_OUTAGE_MS=${outageElapsedMs.toFixed(3)}`);
          expect(outageElapsedMs).toBeLessThan(2_500);
        } finally {
          await blocker.query("ROLLBACK");
          await blocker.end();
        }
      } finally {
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => error === undefined ? resolve() : reject(error))
          );
        }
        await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS todo8_activation_delay ON "DiscordInteractionJob"');
        await database.$executeRawUnsafe('DROP TRIGGER IF EXISTS todo8_stage_delay ON "DiscordInteractionJob"');
        await database.$executeRawUnsafe("DROP FUNCTION IF EXISTS todo8_activation_delay()");
        await database.$executeRawUnsafe("DROP FUNCTION IF EXISTS todo8_stage_delay()");
        await database.discordInteractionJob.deleteMany({
          where: { interactionId: { in: [...normalIds, timeoutId, activationWonId] } }
        });
        await database.discordReservationMessage.deleteMany({ where: { reservationId: "reservation-1" } });
        await database.reservation.deleteMany({ where: { id: "reservation-1" } });
        await database.user.deleteMany({ where: { studentNumber: "31001" } });
        await database.$disconnect();
      }
    },
    120_000
  );
});

function customIdFor(action: "accept" | "admin_cancel" | "no_show" | "reject"): string {
  return buildDiscordReservationCustomId({
    action, renderedEpoch: 7, reservationId: "reservation-1", secret: "bot-token", sourceIdentity: "source-message-1"
  });
}

function componentPayload(customId: string, interactionId: string = ids.interaction) {
  return {
    application_id: ids.application, channel_id: ids.channel,
    data: { component_type: 2, custom_id: customId }, guild_id: ids.guild, id: interactionId,
    member: { roles: [ids.role], user: { id: ids.user } }, message: { id: ids.message }, token: "interaction-token", type: 3
  };
}

function modalPayload(action: "admin_cancel" | "reject") {
  return {
    ...componentPayload(customIdFor(action)),
    data: { components: [{ components: [{ custom_id: "reason", type: 4, value: "행사 준비" }], type: 1 }], custom_id: customIdFor(action) },
    type: 5
  };
}

function signedJsonRequest(payload: unknown): Request {
  return signedRequest(JSON.stringify(payload));
}

function signedRequest(body: string, input: { readonly signedBody?: string; readonly timestamp?: string } = {}): Request {
  return new Request("https://example.test/api/discord/interactions", signedFetchInit(body, input));
}

function signedFetchInit(body: string, input: { readonly signedBody?: string; readonly timestamp?: string } = {}): RequestInit {
  const timestamp = input.timestamp ?? TIMESTAMP;
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), Buffer.from(input.signedBody ?? body)]),
    keyPair.privateKey
  ).toString("hex");
  return {
    body,
    headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp },
    method: "POST"
  };
}
