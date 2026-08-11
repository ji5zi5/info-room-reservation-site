import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";

type SmokeMode = "full" | "route";
type SmokeInput = { readonly mode: SmokeMode; readonly port: number };
type HttpResult = { readonly body: unknown; readonly status: number };

const applicationId = "123456789012345678";
const channelId = "223456789012345678";
const guildId = "323456789012345678";
const adminRoleId = "623456789012345678";
const discordUserId = "723456789012345678";
const messageId = "523456789012345678";

async function main(): Promise<void> { // no-excuse-ok: catch
  const input = parseArguments(process.argv.slice(2));
  const databaseUrl = input.mode === "full"
    ? requireSafeTestDatabase(process.env.INTEGRATION_DATABASE_URL)
    : "postgresql://fixture:fixture@127.0.0.1:1/info_room_test";
  if (!(await isPortFree(input.port))) throw new TypeError(`Port ${input.port} is already in use.`);

  const keys = generateKeyPairSync("ed25519");
  const publicKeyDer = keys.publicKey.export({ format: "der", type: "spki" });
  const publicKey = publicKeyDer.subarray(publicKeyDer.byteLength - 32).toString("hex");
  const server = startNext(input.port, databaseUrl, publicKey);
  try {
    await waitForServer(input.port, server);
    const assertions = await runSignedRouteScenario(input.port, keys.privateKey);
    process.stdout.write(`${JSON.stringify({ assertions, mode: input.mode, ok: true }, null, 2)}\n`);
  } finally {
    await stopServer(server);
    const cleaned = await isPortFree(input.port);
    process.stdout.write(`cleanup: port ${input.port} ${cleaned ? "free" : "busy"}\n`);
    if (!cleaned) throw new TypeError(`Port ${input.port} was not released.`);
  }
}

async function runSignedRouteScenario(port: number, privateKey: KeyObject) {
  const ping = await sendSigned(port, privateKey, { application_id: applicationId, type: 1 });
  const tampered = await sendSigned(port, privateKey, { application_id: applicationId, type: 1 }, true);
  const deferredComponent = await sendSigned(port, privateKey, actionPayload(3));
  const deferredModal = await sendSigned(port, privateKey, actionPayload(5));
  assertHttp("signed PING", ping, 200, 1);
  assertHttp("tampered PING", tampered, 401);
  assertHttp("deferred component", deferredComponent, 200, 5);
  assertHttp("modal submit", deferredModal, 200, 5);
  return {
    deferredComponent: `${deferredComponent.status}/type=${responseType(deferredComponent.body)}`,
    modalSubmit: `${deferredModal.status}/type=${responseType(deferredModal.body)}`,
    ping: `${ping.status}/type=${responseType(ping.body)}`,
    tampered: `${tampered.status}`
  } as const;
}

function actionPayload(type: 3 | 5) {
  const base = {
    application_id: applicationId, channel_id: channelId, guild_id: guildId, id: "423456789012345678",
    member: { roles: [adminRoleId], user: { id: discordUserId } }, message: { id: messageId }, token: "local-fixture-token"
  } as const;
  return type === 3
    ? { ...base, data: { component_type: 2, custom_id: "reservation:accept:route-fixture" }, type }
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

function startNext(port: number, databaseUrl: string, publicKey: string): ChildProcess {
  const server = spawn(process.execPath, [join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
      DISCORD_ADMIN_ROLE_ID: adminRoleId, DISCORD_ADMIN_USER_MAP: `${discordUserId}:31001`,
      DISCORD_APPLICATION_ID: applicationId, DISCORD_BOT_TOKEN: "local-fixture-token", DISCORD_CHANNEL_ID: channelId,
      DISCORD_GUILD_ID: guildId, DISCORD_PUBLIC_KEY: publicKey, NODE_ENV: "development"
    },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  server.stdout?.resume();
  server.stderr?.resume();
  return server;
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
  process.stderr.write(`${error instanceof Error ? error.message : "Discord interaction smoke failed"}\n`);
  process.exitCode = 1;
});
