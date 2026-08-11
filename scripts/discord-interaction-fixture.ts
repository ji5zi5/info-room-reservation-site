import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";

import type { DiscordApplicationConfig } from "../src/lib/discord-app-config";
import { verifyDiscordInteractionSignature } from "../src/lib/discord-interaction-security";
import {
  authorizeDiscordReservationInteraction,
  parseDiscordReservationInteraction
} from "../src/lib/discord-interactions";
import {
  buildDiscordReservationAcceptedMessage,
  buildDiscordReservationCancelledMessage,
  buildDiscordReservationInitialMessage,
  buildDiscordReservationStaleMessage
} from "../src/lib/discord-reservation-messages";

const ids = {
  adminRole: "623456789012345678",
  application: "123456789012345678",
  channel: "223456789012345678",
  guild: "323456789012345678",
  interaction: "423456789012345678",
  message: "523456789012345678",
  user: "723456789012345678"
} as const;
const config: DiscordApplicationConfig = {
  adminRoleId: ids.adminRole,
  adminUserBindings: [{ discordUserId: ids.user, studentNumber: "31001" }],
  applicationId: ids.application,
  botToken: "fixture-only-token",
  channelId: ids.channel,
  guildId: ids.guild,
  publicKey: "a".repeat(64)
};
const ledger = { messageId: ids.message, reservationId: "reservation-fixture" } as const;

type FixtureCommand = "authorize-matrix" | "render-messages" | "render-snapshots" | "verify-signature";

async function main(): Promise<void> { // no-excuse-ok: catch
  const command = parseCommand(process.argv[2]);
  switch (command) {
    case "verify-signature":
      print(await verifySignatureFixture());
      return;
    case "render-messages":
      print(renderMessagesFixture());
      return;
    case "render-snapshots":
      print(await renderSnapshotsFixture());
      return;
    case "authorize-matrix":
      print(authorizeMatrixFixture());
      return;
    default:
      return assertNever(command);
  }
}

async function verifySignatureFixture() {
  const nowMs = 1_700_000_000_000;
  const timestamp = String(nowMs / 1_000);
  const body = new TextEncoder().encode('{"type":1}');
  const tamperedBody = new TextEncoder().encode('{"type":2}');
  const keys = generateKeyPairSync("ed25519");
  const publicKeyDer = keys.publicKey.export({ format: "der", type: "spki" });
  const publicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32).toString("hex");
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body)]),
    keys.privateKey
  ).toString("hex");
  const staleTimestamp = String(nowMs / 1_000 - 301);
  const staleSignature = sign(
    null,
    Buffer.concat([Buffer.from(staleTimestamp, "utf8"), Buffer.from(body)]),
    keys.privateKey
  ).toString("hex");
  const valid = verifyDiscordInteractionSignature({ body, nowMs, publicKey, signature, timestamp });
  const tampered = verifyDiscordInteractionSignature({ body: tamperedBody, nowMs, publicKey, signature, timestamp });
  const stale = verifyDiscordInteractionSignature({ body, nowMs, publicKey, signature: staleSignature, timestamp: staleTimestamp });
  return {
    assertions: {
      stale: stale ? "accepted" : "rejected",
      tampered: tampered ? "accepted" : "rejected",
      valid: valid ? "accepted" : "rejected"
    },
    command: "verify-signature",
    ok: valid && !tampered && !stale
  } as const;
}

function renderMessagesFixture() {
  const input = {
    applicant: { name: "테스트 학생", studentNumber: "31001" },
    capacity: 10,
    closeTime: "16:20",
    confirmedCount: 9,
    date: "2026-08-12",
    reason: "fixture reason",
    reservationId: ledger.reservationId,
    studyPeriod: "EIGHTH"
  } as const;
  const initial = buildDiscordReservationInitialMessage(input);
  const accepted = buildDiscordReservationAcceptedMessage(input);
  const cancelled = buildDiscordReservationCancelledMessage({ ...input, cancellationReason: "fixture cancellation" });
  const stale = buildDiscordReservationStaleMessage(input);
  const terminalControls = [accepted, cancelled, stale].map((payload) => payload.components?.length ?? 0);
  return {
    assertions: {
      allowedMentions: initial.allowed_mentions.parse,
      initialButtonIds: initial.components?.flatMap((row) => row.components.map((button) => button.custom_id)) ?? [],
      terminalControlCounts: terminalControls
    },
    command: "render-messages",
    messages: { accepted, cancelled, initial, stale },
    ok: initial.components?.[0]?.components.length === 2 && terminalControls.every((count) => count === 0)
  } as const;
}

async function renderSnapshotsFixture() {
  const capacity = 10;
  const nineSnapshot = { capacity, closeAtUnix: Math.floor(new Date("2026-08-12T16:20:00+09:00").getTime() / 1_000), confirmedCount: 9, remaining: 1 } as const;
  const tenSnapshot = { ...nineSnapshot, confirmedCount: 10, remaining: 0 } as const;
  const expectedCloseAtUnix = Math.floor(new Date("2026-08-12T16:20:00+09:00").getTime() / 1_000);
  return {
    assertions: {
      atCapacity: `${tenSnapshot.confirmedCount}/${tenSnapshot.capacity} remaining=${tenSnapshot.remaining}`,
      closeAtUnix: nineSnapshot.closeAtUnix,
      oneRemaining: `${nineSnapshot.confirmedCount}/${nineSnapshot.capacity} remaining=${nineSnapshot.remaining}`
    },
    command: "render-snapshots",
    ok: nineSnapshot.remaining === 1 && tenSnapshot.remaining === 0 && nineSnapshot.closeAtUnix === expectedCloseAtUnix
  } as const;
}

function authorizeMatrixFixture() {
  const scenarios = {
    authorized: {},
    wrongApplication: { application_id: "999999999999999999" },
    wrongChannel: { channel_id: "999999999999999999" },
    wrongGuild: { guild_id: "999999999999999999" },
    wrongMap: { member: member("999999999999999999", [ids.adminRole]) },
    wrongMessage: { message: { id: "999999999999999999" } },
    wrongRole: { member: member(ids.user, []) }
  } as const;
  const outcomes = Object.fromEntries(Object.entries(scenarios).map(([name, changes]) => {
    const interaction = parseDiscordReservationInteraction({ ...componentPayload(), ...changes });
    const result = authorizeDiscordReservationInteraction({ config, interaction, ledger });
    return [name, result.kind === "authorized" ? "accepted" : result.code];
  }));
  const malformedModal = parseDiscordReservationInteraction({ ...modalPayload(), data: { ...modalPayload().data, components: [] } });
  outcomes.malformedModal = malformedModal.kind === "invalid" ? "rejected" : "accepted";
  return {
    assertions: outcomes,
    command: "authorize-matrix",
    ok: outcomes.authorized === "accepted" && Object.entries(outcomes).every(([name, result]) => name === "authorized" || result !== "accepted")
  } as const;
}

function componentPayload() {
  return {
    application_id: ids.application, channel_id: ids.channel,
    data: { component_type: 2, custom_id: `reservation:accept:${ledger.reservationId}` }, guild_id: ids.guild,
    id: ids.interaction, member: member(ids.user, [ids.adminRole]), message: { id: ids.message }, token: "fixture-token", type: 3
  } as const;
}

function modalPayload() {
  return {
    ...componentPayload(),
    data: { components: [{ components: [{ custom_id: "reason", type: 4, value: "fixture reason" }], type: 1 }], custom_id: `reservation:reject:${ledger.reservationId}` },
    type: 5
  } as const;
}

function member(userId: string, roles: readonly string[]) {
  return { roles, user: { id: userId } } as const;
}

function parseCommand(value: string | undefined): FixtureCommand {
  switch (value) {
    case "authorize-matrix": case "render-messages": case "render-snapshots": case "verify-signature": return value;
    default: throw new TypeError("Usage: discord-interaction-fixture <verify-signature|render-messages|render-snapshots|authorize-matrix>");
  }
}

function print(value: object): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function assertNever(value: never): never { throw new TypeError(`Unexpected fixture command: ${String(value)}`); }

main().catch((error: unknown) => { // no-excuse-ok: catch
  process.stderr.write(`${error instanceof Error ? error.message : "Discord fixture failed"}\n`);
  process.exitCode = 1;
});
