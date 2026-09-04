// allow: SIZE_OK — signed route process control and its database/fake-Discord lifecycle are one auditable smoke.
import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer as createHttpServer, request, type Server } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import { buildReservationMessageNonce } from "../src/lib/discord-bot";
import {
  createFencedDiscordDisable,
  DiscordDisablePendingError,
  reenableDiscordOperations
} from "../src/lib/discord-disable-pending";
import {
  activateDiscordInteractionJob,
  prismaDiscordInteractionJobStore,
  stageDiscordInteractionJob
} from "../src/lib/prisma-discord-interaction-job-store";
import { beginSyncPatch, saveLeasedSyncSuccess } from "../src/lib/prisma-discord-reservation-message-sync";
import { buildDiscordReservationCustomId } from "../src/lib/discord-interactions";
import {
  buildDiscordLoopbackNodeOptions,
  createPrismaDiscordOperationsFenceRuntime
} from "./operational-rollout-smoke";

type SmokeMode = "full" | "route";
type SmokeInput = { readonly mode: SmokeMode; readonly port: number };
type HttpResult = { readonly body: unknown; readonly status: number };

const applicationId = "123456789012345678";
const channelId = "223456789012345678";
const guildId = "323456789012345678";
const adminRoleId = "623456789012345678";
const discordUserId = "723456789012345678";
const messageId = "523456789012345678";
const reservationId = "route-fixture";
const botToken = "local-fixture-token";
const adminCommandInteractionId = "823456789012345678";
const adminCommandToken = "admin-command-token";

async function main(): Promise<void> { // no-excuse-ok: catch
  const input = parseArguments(process.argv.slice(2));
  const databaseUrl = input.mode === "full"
    ? requireSafeTestDatabase(process.env.INTEGRATION_DATABASE_URL)
    : "postgresql://fixture:fixture@127.0.0.1:1/info_room_test";
  if (!(await isPortFree(input.port))) throw new TypeError(`Port ${input.port} is already in use.`);

  const keys = generateKeyPairSync("ed25519");
  const publicKeyDer = keys.publicKey.export({ format: "der", type: "spki" });
  const publicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32).toString("hex");
  const fakeDiscord = input.mode === "full" ? await startFakeDiscord() : null;
  if (input.mode === "full") await prepareFullFixture(databaseUrl);
  const server = startNext(input.port, databaseUrl, publicKey, fakeDiscord?.url);
  try {
    await waitForServer(input.port, server);
    const assertions = await runSignedRouteScenario(input.port, keys.privateKey, input.mode, databaseUrl, fakeDiscord);
    process.stdout.write(`${JSON.stringify({ assertions, mode: input.mode, ok: true }, null, 2)}\n`);
  } finally {
    await stopServer(server);
    await fakeDiscord?.close();
    const cleaned = await isPortFree(input.port);
    process.stdout.write(`cleanup: port ${input.port} ${cleaned ? "free" : "busy"}\n`);
    if (!cleaned) throw new TypeError(`Port ${input.port} was not released.`);
  }
}

async function runSignedRouteScenario(
  port: number,
  privateKey: KeyObject,
  mode: SmokeMode,
  databaseUrl: string,
  fakeDiscord: FakeDiscord | null
) {
  const ping = await sendSigned(port, privateKey, { application_id: applicationId, type: 1 });
  const tampered = await sendSigned(port, privateKey, { application_id: applicationId, type: 1 }, true);
  const deferredComponent = await sendSigned(port, privateKey, actionPayload(3, mode));
  const deferredModal = await sendSigned(port, privateKey, actionPayload(5));
  const adminStatus = mode === "full" ? await sendSigned(port, privateKey, adminStatusPayload()) : null;
  assertHttp("signed PING", ping, 200, 1);
  assertHttp("tampered PING", tampered, 401);
  assertHttp("deferred component", deferredComponent, mode === "full" ? 200 : 400, mode === "full" ? 5 : 4);
  assertHttp("modal submit", deferredModal, 400, 4);
  if (adminStatus !== null) assertHttp("admin status command", adminStatus, 200, 5);
  const adminCommand = mode === "full" ? await assertAdminStatusLifecycle(fakeDiscord) : "route-only";
  const lifecycle = mode === "full" ? await assertFullLifecycle(databaseUrl, fakeDiscord, port) : "route-only";
  const fenceStress = mode === "full" ? await assertFenceStress(databaseUrl, fakeDiscord) : "route-only";
  return {
    deferredComponent: `${deferredComponent.status}/type=${responseType(deferredComponent.body)}`,
    modalSubmit: `${deferredModal.status}/type=${responseType(deferredModal.body)}`,
    ping: `${ping.status}/type=${responseType(ping.body)}`,
    tampered: `${tampered.status}`,
    adminCommand,
    fenceStress,
    lifecycle
  } as const;
}

function adminStatusPayload() {
  return {
    application_id: applicationId,
    channel_id: channelId,
    data: { name: "현황" },
    guild_id: guildId,
    id: adminCommandInteractionId,
    member: { roles: [adminRoleId], user: { id: discordUserId } },
    token: adminCommandToken,
    type: 2
  } as const;
}

async function assertAdminStatusLifecycle(fakeDiscord: FakeDiscord | null): Promise<string> {
  if (fakeDiscord === null) throw new TypeError("Admin command lifecycle requires fake Discord.");
  const expectedPath = `PATCH /api/v10/webhooks/${applicationId}/${adminCommandToken}/messages/%40original`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fakeDiscord.requests.includes(expectedPath)) return "signed-command/admin-map/public-defer/original-PATCH";
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new TypeError(`Admin status command did not settle: ${JSON.stringify(fakeDiscord.requests)}`);
}

function actionPayload(type: 3 | 5, mode: SmokeMode = "route") {
  const base = {
    application_id: applicationId, channel_id: channelId, guild_id: guildId, id: "423456789012345678",
    member: { roles: [adminRoleId], user: { id: discordUserId } }, message: { id: messageId }, token: "local-fixture-token"
  } as const;
  return type === 3
    ? {
        ...base,
        data: {
          component_type: 2,
          custom_id: mode === "full"
            ? buildDiscordReservationCustomId({
                action: "accept",
                renderedEpoch: 7,
                reservationId,
                secret: botToken,
                sourceIdentity: buildReservationMessageNonce(reservationId)
              })
            : "reservation:accept:route-fixture"
        },
        type
      }
    : {
        ...base,
        data: { components: [{ components: [{ custom_id: "reason", type: 4, value: "route fixture" }], type: 1 }], custom_id: "reservation:reject:route-fixture" },
        type
      };
}

async function sendSigned(port: number, privateKey: KeyObject, payload: object, tamper = false): Promise<HttpResult> {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signedBody = JSON.stringify(payload);
  const body = tamper ? `${signedBody} ` : signedBody;
  const signature = sign(null, Buffer.from(`${timestamp}${signedBody}`, "utf8"), privateKey).toString("hex");
  return post(port, body, { "x-signature-ed25519": signature, "x-signature-timestamp": timestamp });
}

function post(port: number, body: string, headers: Readonly<Record<string, string>>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      headers: { ...headers, "content-length": Buffer.byteLength(body), "content-type": "application/json" },
      host: "127.0.0.1", method: "POST", path: "/api/discord/interactions", port
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) reject(error); }
        resolve({ body: parsed, status: incoming.statusCode ?? 0 });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function startNext(port: number, databaseUrl: string, publicKey: string, fakeDiscordUrl?: string): ChildProcess {
  const applicationDatabaseUrl = databaseUrlWithUtcSession(databaseUrl);
  const server = spawn(process.execPath, [join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env, DATABASE_URL: applicationDatabaseUrl, DEPLOYMENT_SHA: "b".repeat(40), DIRECT_URL: applicationDatabaseUrl,
      CLOSED_PERIOD_CRON_SECRET: "fixture-cron-secret",
      DISCORD_ADMIN_ROLE_ID: adminRoleId, DISCORD_ADMIN_USER_MAP: `${discordUserId}:31001`,
      DISCORD_APPLICATION_ID: applicationId, DISCORD_BOT_TOKEN: botToken, DISCORD_CHANNEL_ID: channelId,
      DISCORD_GUILD_ID: guildId, DISCORD_PUBLIC_KEY: publicKey,
      ...(fakeDiscordUrl === undefined ? {} : {
        DISCORD_FAKE_BASE_URL: fakeDiscordUrl,
        DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/local-fixture-token",
        NODE_OPTIONS: buildDiscordLoopbackNodeOptions(fakeDiscordUrl, process.env.NODE_OPTIONS)
      }),
      NODE_ENV: "development",
      TZ: "UTC"
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  server.stdout?.pipe(process.stderr);
  server.stderr?.pipe(process.stderr);
  return server;
}

async function assertFenceStress(databaseUrl: string, fakeDiscord: FakeDiscord | null) {
  if (fakeDiscord === null) throw new TypeError("Fence stress requires fake Discord.");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const now = new Date("2026-08-18T12:00:00.000Z");
  const interactionId = "fence-stress-interaction";
  const claimId = "fence-stress-claim";
  const operationId = "fence-stress-operation";
  const priorDeploymentSha = process.env.DEPLOYMENT_SHA;
  let releaseTransport = (): void => undefined;
  let lateTransport: Promise<boolean> | undefined;
  let countWindowLease: Promise<boolean> | undefined;
  let countWindowLeaseInput: Parameters<typeof beginSyncPatch>[0] | undefined;
  const operations = createPrismaDiscordOperationsFenceRuntime(databaseUrl, {
    afterFenceBeforeTransportCount: () => {
      if (countWindowLeaseInput === undefined) {
        throw new TypeError("Fence stress count-window lease input was not initialized.");
      }
      countWindowLease = beginSyncPatch(countWindowLeaseInput);
      void countWindowLease.catch(() => undefined);
    }
  });
  try {
    process.env.DEPLOYMENT_SHA = "b".repeat(40);
    const control = await prisma.discordOperationsControl.findUniqueOrThrow({ where: { id: "discord-operations" } });
    const message = await prisma.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } });
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.application_contract', 'discord-ops-v2', true)`;
      await transaction.discordReservationMessage.update({
        data: {
          syncClaimId: claimId,
          syncClaimRevision: message.messageRevision,
          syncClaimedAt: now,
          syncNextAttemptAt: null,
          syncStatus: "CLAIMED"
        },
        where: { reservationId }
      });
    });
    const commandDigest = "fence-stress-digest";
    const staged = await stageDiscordInteractionJob({
      activationDeadline: new Date(Date.now() + 60_000),
      commandDigest,
      discordActorId: discordUserId,
      interactionId,
      intent: "ACCEPT",
      ipHash: "fence-stress-ip",
      localActorId: "route-admin",
      renderedEpoch: control.epoch,
      reservationId,
      sourceApplicationId: applicationId,
      sourceChannelId: channelId,
      sourceGuildId: guildId,
      sourceMessageId: messageId
    });
    if (staged.kind !== "enqueued") throw new TypeError(`Fence stress job was not staged: ${staged.kind}`);
    const acknowledged = await activateDiscordInteractionJob({ commandDigest, interactionId });
    if (acknowledged.kind !== "pending") throw new TypeError(`Fence stress job was not acknowledged: ${acknowledged.kind}`);

    const paused = deferred<void>();
    const released = deferred<void>();
    releaseTransport = () => released.resolve();
    const fakePatchCountBefore = fakeDiscord.requests.filter((entry) => entry.startsWith("PATCH ")).length;
    lateTransport = (async () => {
      const leased = await beginSyncPatch({
        claimId,
        deadlineAt: new Date(now.getTime() + 30_000),
        epoch: control.epoch,
        operationId,
        reservationId,
        revision: message.messageRevision
      });
      if (!leased) throw new TypeError("Fence stress could not acquire the pre-fence PATCH lease.");
      paused.resolve();
      await released.promise;
      const response = await fetch(`${fakeDiscord.url}/api/v10/channels/${channelId}/messages/${messageId}`, {
        body: JSON.stringify({ content: "late pre-fence transport" }),
        headers: { "content-type": "application/json" },
        method: "PATCH"
      });
      if (!response.ok) throw new TypeError(`Fence stress fake transport returned ${response.status}.`);
      return saveLeasedSyncSuccess({
        claimId,
        epoch: control.epoch,
        operationId,
        reservationId,
        revision: message.messageRevision,
        syncedAt: new Date(now.getTime() + 2_000)
      });
    })();
    void lateTransport.catch(paused.reject);
    await paused.promise;
    countWindowLeaseInput = {
      claimId: "count-window-claim",
      deadlineAt: new Date(now.getTime() + 30_000),
      epoch: control.epoch,
      operationId: "count-window-operation",
      reservationId,
      revision: message.messageRevision
    };

    const disabled = await createFencedDiscordDisable({
      bot: { editChannelMessage: async () => { throw new TypeError("No cleanup claim should start during a held PATCH lease."); } },
      loadSnapshot: async (missingReservationId) => ({ kind: "not_found", reservationId: missingReservationId }),
      operations: operations.repository,
      repository: {
        claimActiveMessagesForDisable: async () => [],
        completeDisableClaim: async () => false,
        releaseDisableClaim: async () => false
      }
    })({ now });
    if (disabled.epoch !== control.epoch + 1 || !disabled.pendingRemoteCleanup) {
      throw new TypeError(`Fence stress did not track the pre-fence transport: ${JSON.stringify(disabled)}`);
    }
    if (countWindowLease === undefined) {
      throw new TypeError("Fence stress did not start the count-window lease contender.");
    }
    const countWindowLeaseStarted = await countWindowLease;
    if (countWindowLeaseStarted) {
      throw new TypeError("Fence stress allowed a transport to start after the fence and before transport accounting.");
    }
    const newLeaseStarted = await beginSyncPatch({
      claimId: "post-fence-claim",
      deadlineAt: new Date(now.getTime() + 30_000),
      epoch: disabled.epoch,
      operationId: "post-fence-operation",
      reservationId,
      revision: message.messageRevision
    });
    const disabledClaims = await prismaDiscordInteractionJobStore.claim(now, interactionId);
    if (newLeaseStarted || disabledClaims.length !== 0) {
      throw new TypeError("Fence stress allowed a new transport lease or reservation mutation while disabled.");
    }

    let acknowledgementRequired = false;
    try {
      await reenableDiscordOperations({ acknowledgeResidualInertControls: false, now, repository: operations.repository });
    } catch (error) {
      acknowledgementRequired = error instanceof DiscordDisablePendingError && error.code === "RESIDUAL_ACK_REQUIRED";
      if (!acknowledgementRequired) throw error;
    }
    if (!acknowledgementRequired) throw new TypeError("Fence stress re-enabled without residual-control acknowledgement.");
    const reenabled = await reenableDiscordOperations({
      acknowledgeResidualInertControls: true,
      now: new Date(now.getTime() + 1_000),
      repository: operations.repository
    });
    const staleClaims = await prismaDiscordInteractionJobStore.claim(new Date(now.getTime() + 1_000), interactionId);
    if (reenabled.epoch !== disabled.epoch + 1 || staleClaims.length !== 0) {
      throw new TypeError("Fence stress allowed an old-epoch control after re-enable.");
    }

    releaseTransport();
    const lateTransportTracked = await lateTransport;
    const [settledMessage, settledControl, staleJob] = await Promise.all([
      prisma.discordReservationMessage.findUniqueOrThrow({ where: { reservationId } }),
      prisma.discordOperationsControl.findUniqueOrThrow({ where: { id: "discord-operations" } }),
      prisma.discordInteractionJob.findUniqueOrThrow({ where: { interactionId } })
    ]);
    const fakePatchCountAfter = fakeDiscord.requests.filter((entry) => entry.startsWith("PATCH ")).length;
    if (
      !lateTransportTracked || fakePatchCountAfter !== fakePatchCountBefore + 1 ||
      settledMessage.syncStatus !== "SYNCED" || settledMessage.renderedSourceEpoch !== control.epoch ||
      settledControl.epoch !== reenabled.epoch || staleJob.renderedEpoch === settledControl.epoch
    ) {
      throw new TypeError("Fence stress did not retain the late transport as an inert old-epoch result.");
    }
    return {
      acknowledgementRequired,
      countWindowLeaseStarted,
      disabledEpoch: disabled.epoch,
      lateTransportTracked,
      newLeaseStarted,
      oldControlInert: staleJob.renderedEpoch !== settledControl.epoch,
      pendingRemoteCleanup: disabled.pendingRemoteCleanup,
      reenabledEpoch: reenabled.epoch
    } as const;
  } finally {
    releaseTransport();
    await lateTransport?.catch(() => false);
    await operations.close();
    await prisma.$disconnect();
    if (priorDeploymentSha === undefined) delete process.env.DEPLOYMENT_SHA;
    else process.env.DEPLOYMENT_SHA = priorDeploymentSha;
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (reason?: unknown) => void;
  readonly resolve: (value: T) => void;
} {
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: (reason) => {
      if (rejectPromise === undefined) throw new TypeError("Deferred promise was not initialized.");
      rejectPromise(reason);
    },
    resolve: (value) => {
      if (resolvePromise === undefined) throw new TypeError("Deferred promise was not initialized.");
      resolvePromise(value);
    }
  };
}

function databaseUrlWithUtcSession(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c timezone=UTC");
  return url.toString();
}

type FakeDiscord = {
  readonly close: () => Promise<void>;
  readonly requests: string[];
  readonly url: string;
};

async function startFakeDiscord(): Promise<FakeDiscord> {
  const requests: string[] = [];
  const server = createHttpServer((incoming, response) => {
    requests.push(`${incoming.method ?? "UNKNOWN"} ${incoming.url ?? "/"}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(incoming.method === "GET" ? JSON.stringify({ roles: [adminRoleId] }) : JSON.stringify({ id: messageId }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("Fake Discord did not bind a TCP port.");
  return {
    close: () => closeHttpServer(server),
    requests,
    url: `http://127.0.0.1:${address.port}`
  };
}

async function prepareFullFixture(databaseUrl: string): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT set_config('app.application_contract', 'discord-ops-v2', true)`;
      await transaction.discordInteractionJob.deleteMany({ where: { reservationId } });
      await transaction.discordInteractionReceipt.deleteMany({ where: { reservationId } });
      await transaction.discordReservationMessage.deleteMany({ where: { reservationId } });
      await transaction.reservation.deleteMany({ where: { id: reservationId } });
      await transaction.user.upsert({
        create: { generation: 3, id: "route-admin", name: "Route Admin", role: "ADMIN", studentNumber: "31001" },
        update: { role: "ADMIN" },
        where: { studentNumber: "31001" }
      });
      const applicant = await transaction.user.upsert({
        create: { generation: 3, id: "route-student", name: "Route Student", studentNumber: "32001" },
        update: {},
        where: { studentNumber: "32001" }
      });
      await transaction.reservation.create({ data: {
        date: "2026-08-18", id: reservationId, reason: "signed lifecycle", studyPeriod: "EIGHTH", userId: applicant.id
      } });
      await transaction.discordReservationMessage.create({ data: {
        channelId, guildId, initialSendOutcome: "SENT", initialSendStatus: "SENT",
        legacyControlState: "CURRENT", messageId, nonce: buildReservationMessageNonce(reservationId),
        renderedSourceEpoch: 7, reservationId, syncStatus: "SYNCED"
      } });
      await transaction.discordOperationsControl.update({
        data: { enabled: true, epoch: 7, pendingRemoteCleanup: false },
        where: { id: "discord-operations" }
      });
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function assertFullLifecycle(databaseUrl: string, fakeDiscord: FakeDiscord | null, port: number): Promise<string> {
  if (fakeDiscord === null) throw new TypeError("Full lifecycle requires fake Discord.");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const initialMarker = await prisma.schemaCompatibility.findUniqueOrThrow({ where: { id: "discord-operations" } });
    const startsActivated = initialMarker.activatedAt !== null;
    let lastState: unknown = null;
    let cronTriggered = false;
    let activationTriggered = false;
    let recoveryCronTriggered = false;
    let activationCronStatus: number | null = null;
    let guardedCronStatus: number | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [receipt, message, job, marker, activationReceipt, actionCount, auditCount] = await Promise.all([
        prisma.discordInteractionReceipt.findUnique({ where: { interactionId: "423456789012345678" } }),
        prisma.discordReservationMessage.findUnique({ where: { reservationId } }),
        prisma.discordInteractionJob.findUnique({ where: { interactionId: "423456789012345678" } }),
        prisma.schemaCompatibility.findUnique({ where: { id: "discord-operations" } }),
        prisma.applicationDeploymentReceipt.findFirst({
          where: {
            ...(startsActivated ? {} : { activationSource: "FIRST_CRON" }),
            consumedAt: { not: null },
            deploymentSha: "b".repeat(40)
          }
        }),
        prisma.adminAction.count({ where: { action: "DISCORD_RESERVATION_ACCEPT", reservationId } }),
        prisma.auditLog.count({ where: { action: "DISCORD_RESERVATION_ACCEPT" } })
      ]);
      const patched = fakeDiscord.requests.some((entry) => entry.startsWith("PATCH /api/v10/channels/"));
      lastState = { actionCount, activationReceipt, auditCount, job, marker, message, patched, receipt, requests: fakeDiscord.requests };
      if (message?.decision === "ACCEPTED" && !cronTriggered) {
        cronTriggered = true;
        const guardedCron = await getCron(port);
        guardedCronStatus = guardedCron.status;
        const expectedStatus = startsActivated ? 200 : 502;
        if (guardedCron.status !== expectedStatus) {
          throw new TypeError(`Activation guard returned ${guardedCron.status}, expected ${expectedStatus}: ${JSON.stringify(guardedCron)}`);
        }
      }
      if (job?.status === "PENDING" && attempt >= 20 && !recoveryCronTriggered) {
        recoveryCronTriggered = true;
        await getCron(port);
      }
      if (patched && !activationTriggered) {
        activationTriggered = true;
        if (!startsActivated) {
          await prisma.$transaction(async (transaction) => {
            await transaction.$executeRaw`SELECT set_config('app.application_contract', 'discord-ops-v2', true)`;
            await transaction.discordOperationsControl.update({
              data: { enabled: false },
              where: { id: "discord-operations" }
            });
          });
        }
        const activationCron = await getCron(port);
        activationCronStatus = activationCron.status;
        if (activationCron.status !== 200) {
          throw new TypeError(`Activation cron did not settle successfully: ${JSON.stringify(activationCron)}`);
        }
      }
      if (
        receipt?.terminalOutcome === "ACCEPTED" && message?.decision === "ACCEPTED" &&
        actionCount === 1 && auditCount >= 1 && patched && marker?.minimumApplicationContract === "discord-ops-v2" &&
        marker.deploymentSha === "b".repeat(40) && activationReceipt !== null
      ) {
        const activationPath = startsActivated ? "already-active" : "FIRST_CRON-activation";
        return `signed-command/auth/reservation/audit/receipt/source-PATCH/${activationPath}/cron=${guardedCronStatus}->${activationCronStatus}`;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new TypeError(`Full lifecycle did not settle: ${JSON.stringify(lastState)}`);
  } finally {
    await prisma.$disconnect();
  }
}

function getCron(port: number): Promise<HttpResult> {
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request({
      headers: { authorization: "Bearer fixture-cron-secret" },
      host: "127.0.0.1",
      method: "GET",
      path: "/api/cron/closed-period-notifications",
      port
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try { body = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) rejectRequest(error); }
        resolveRequest({ body, status: incoming.statusCode ?? 0 });
      });
    });
    outgoing.once("error", rejectRequest);
    outgoing.end();
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  });
}

async function waitForServer(port: number, server: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server.exitCode !== null) throw new TypeError(`Next server exited before readiness with code ${server.exitCode}.`);
    try { await post(port, "{}", {}); return; } catch (error) {
      if (!(error instanceof Error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new TypeError("Next server did not become ready within 20 seconds.");
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  if (process.platform === "win32" && server.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(server.pid), "/f", "/t"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    await new Promise<void>((resolveKill) => {
      killer.once("close", () => resolveKill());
      killer.once("error", () => resolveKill());
    });
    return;
  }
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    server.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function requireSafeTestDatabase(value: string | undefined): string {
  if (!value) throw new TypeError("Full mode requires INTEGRATION_DATABASE_URL for a loopback PostgreSQL database whose name ends with _test.");
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (error instanceof TypeError) throw new TypeError("Full mode requires INTEGRATION_DATABASE_URL for a loopback PostgreSQL database whose name ends with _test.");
    throw error;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
  if (!loopback || url.protocol !== "postgresql:" || !url.pathname.slice(1).endsWith("_test")) {
    throw new TypeError("Full mode requires INTEGRATION_DATABASE_URL for a loopback PostgreSQL database whose name ends with _test.");
  }
  return value;
}

function parseArguments(args: readonly string[]): SmokeInput {
  const modeIndex = args.indexOf("--mode");
  const portIndex = args.indexOf("--port");
  const mode = args[modeIndex + 1];
  const port = Number(args[portIndex + 1] ?? "3217");
  if ((mode !== "route" && mode !== "full") || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new TypeError("Usage: discord-interaction-smoke --mode <route|full> --port <1024-65535>");
  }
  return { mode, port };
}

function assertHttp(name: string, result: HttpResult, status: number, type?: number): void {
  if (result.status !== status || (type !== undefined && responseType(result.body) !== type)) {
    throw new TypeError(`${name} failed: status=${result.status} type=${responseType(result.body)}`);
  }
}

function responseType(body: unknown): number | null {
  return typeof body === "object" && body !== null && "type" in body && typeof body.type === "number" ? body.type : null;
}

main().catch((error: unknown) => { // no-excuse-ok: catch
  const message = error instanceof Error ? error.message : "Discord interaction smoke failed";
  process.stderr.write(`${message}\n`, () => process.exit(1));
});
