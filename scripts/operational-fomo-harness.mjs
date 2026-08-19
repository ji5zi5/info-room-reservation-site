// allow: SIZE_OK — lifecycle ownership, cancellation, and cleanup must remain one auditable embedded-PostgreSQL boundary.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const SUPPORTED_EMBEDDED_TARGETS = new Set(["win32:x64", "linux:x64"]);
const STAGES = ["install-script", "binary", "initdb", "start", "create", "child", "cleanup", "chromium"];

export class OperationalHarnessError extends Error {
  constructor(stage, message, options = {}) {
    super(message, options);
    this.name = "OperationalHarnessError";
    this.stage = z.enum(STAGES).parse(stage);
  }
}

export function parseSafeTestDatabaseUrl(value) {
  const parsedValue = z.string().url().parse(value);
  const url = new URL(parsedValue);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new OperationalHarnessError("child", "database URL must use PostgreSQL");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) || !url.pathname.slice(1).endsWith("_test")) {
    throw new OperationalHarnessError("child", "database URL must target a loopback _test database");
  }
  if (url.username.length === 0 || url.password.length === 0) {
    throw new OperationalHarnessError("child", "database URL requires generated or pre-authorized credentials");
  }
  return url.toString();
}

export function resolveEmbeddedTarget(platformName = platform(), architecture = arch()) {
  const target = `${platformName}:${architecture}`;
  if (!SUPPORTED_EMBEDDED_TARGETS.has(target)) {
    throw new OperationalHarnessError("binary", `unsupported embedded PostgreSQL target: ${target}`);
  }
  return {
    binarySuffix: platformName === "win32" ? ".exe" : "",
    packageName: platformName === "win32" ? "windows-x64" : "linux-x64",
    target
  };
}

export async function allocateLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new OperationalHarnessError("start", "failed to allocate loopback port")));
        return;
      }
      server.close((error) => error === undefined ? resolvePort(address.port) : reject(error));
    });
  });
}

export async function withOperationalPostgres(options) {
  const preauthorized = options.preauthorizedUrl;
  if (preauthorized !== undefined) {
    if (options.preauthorized !== true) {
      throw new OperationalHarnessError("child", "loopback database reuse requires explicit pre-authorization");
    }
    const databaseUrl = parseSafeTestDatabaseUrl(preauthorized);
    return options.operation({
      databaseUrl,
      directUrl: databaseUrl,
      ownership: "caller",
      receipt: { children: [], dataDirectories: [], databases: [], ports: [], processes: [], status: "not-owned" }
    });
  }

  const target = resolveEmbeddedTarget(options.platformName, options.architecture);
  const root = await mkdtemp(join(tmpdir(), "operational-fomo-pg-"));
  const dataDirectory = join(root, "data");
  const port = await allocateLoopbackPort();
  const suffix = randomBytes(8).toString("hex");
  const user = "postgres";
  const password = randomBytes(24).toString("base64url");
  const database = `fomo_${suffix}_test`;
  const encoded = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  const databaseUrl = parseSafeTestDatabaseUrl(encoded);
  const receipt = {
    children: ["embedded-postgres"], dataDirectories: [dataDirectory], databases: [database], ports: [port], processes: [], status: "pending"
  };
  let embedded;
  try {
    const EmbeddedPostgres = options.embeddedFactory ?? await (options.embeddedLoader ?? loadEmbeddedPostgres)(root, target);
    embedded = await stage("binary", async () => new EmbeddedPostgres({
      authMethod: "scram-sha-256", createPostgresUser: false, databaseDir: dataDirectory,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onError: options.onLog ?? (() => undefined), onLog: options.onLog ?? (() => undefined),
      password, persistent: false, port, postgresFlags: ["-h", "127.0.0.1"], timeoutMs: options.timeoutMs ?? 60_000, user
    }), options.timeoutMs);
    await stage("initdb", (signal) => embedded.initialise(signal), options.timeoutMs);
    await stage("start", (signal) => embedded.start(signal), options.timeoutMs);
    await stage("create", (signal) => embedded.createDatabase(database, signal), options.timeoutMs);
    return await options.operation({ databaseUrl, directUrl: databaseUrl, ownership: "harness", receipt });
  } finally {
    let cleanupError;
    const ownedPids = new Set(ownedProcessIds(embedded));
    if (embedded !== undefined) {
      try {
        await stage("cleanup", (signal) => embedded.stop(signal), options.timeoutMs);
      } catch (error) {
        cleanupError = error;
      }
      for (const pid of ownedProcessIds(embedded)) ownedPids.add(pid);
    }
    for (const pid of ownedPids) {
      const cleaned = !isProcessAlive(pid);
      receipt.processes.push({ pid, cleaned });
      if (!cleaned) cleanupError ??= new OperationalHarnessError("cleanup", `owned PostgreSQL process remains alive: ${pid}`);
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= new OperationalHarnessError("cleanup", "temporary PostgreSQL directory cleanup failed", { cause: error });
    }
    if (cleanupError === undefined) {
      try {
        await access(root);
        cleanupError = new OperationalHarnessError("cleanup", "temporary PostgreSQL root still exists after cleanup");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") cleanupError = error;
      }
    }
    if (cleanupError === undefined && !await isLoopbackPortFree(port)) {
      cleanupError = new OperationalHarnessError("cleanup", `owned PostgreSQL port remains in use: ${port}`);
    }
    receipt.status = cleanupError === undefined ? "cleaned" : "failed";
    if (options.attemptDir !== undefined) {
      try {
        await writeFile(resolve(options.attemptDir, "operational-postgres-cleanup.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
      } catch (error) {
        cleanupError ??= new OperationalHarnessError("cleanup", "cleanup receipt is create-once", { cause: error });
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
}

async function loadEmbeddedPostgres(root, target = resolveEmbeddedTarget()) {
  try {
    await import("embedded-postgres");
    const entry = fileURLToPath(import.meta.resolve(`@embedded-postgres/${target.packageName}`));
    const nativeSource = resolve(dirname(entry), "..", "native");
    const nativeRoot = join(root, "runtime");
    await cp(nativeSource, nativeRoot, { dereference: true, recursive: true });
    return class OwnedEmbeddedPostgres {
      constructor(options) {
        this.activeProcesses = new Set();
        this.options = options;
        this.nativeRoot = nativeRoot;
        this.processHistory = new Set();
      }
      ownedProcessIds() { return [...this.processHistory]; }
      track(record) {
        this.processHistory.add(record.pid);
        this.activeProcesses.add(record);
      }
      untrack(record) { this.activeProcesses.delete(record); }
      async initialise(signal) {
        const executable = binary(this.nativeRoot, "initdb", target.binarySuffix);
        const passwordPath = join(root, "init-password");
        await writeFile(passwordPath, `${this.options.password}\n`, { flag: "wx" });
        try {
          await runOwnedBinary(executable, [
            `--pgdata=${this.options.databaseDir}`, `--auth=${this.options.authMethod}`,
            `--username=${this.options.user}`, `--pwfile=${passwordPath}`, "--encoding=UTF8", "--locale=C"
          ], "initdb", this.options.onLog, {
            onProcess: (record) => this.track(record), onSettled: (record) => this.untrack(record),
            platformName: target.target.split(":")[0], signal, timeoutMs: this.options.timeoutMs
          });
        } finally {
          await rm(passwordPath, { force: true });
        }
      }
      async start(signal) {
        const executable = binary(this.nativeRoot, "postgres", target.binarySuffix);
        this.process = spawn(executable, ["-D", this.options.databaseDir, "-p", String(this.options.port), "-h", "127.0.0.1"], {
          env: { ...process.env, LC_MESSAGES: "C" }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          ...resolveOwnedSpawnOptions(target.target.split(":")[0])
        });
        const record = processRecord(this.process);
        this.track(record);
        record.terminal.finally(() => this.untrack(record));
        const ready = new Promise((resolveReady) => {
          const inspect = (chunk) => {
            const message = chunk.toString(); this.options.onLog(message);
            if (message.includes("database system is ready to accept connections")) resolveReady({ kind: "ready" });
          };
          this.process.stdout.on("data", inspect); this.process.stderr.on("data", inspect);
        });
        const outcome = await operationOutcome(ready, record.terminal, signal, this.options.timeoutMs);
        if (outcome.kind === "ready") return;
        if (outcome.kind === "error") throw outcome.error;
        if (outcome.kind === "close") throw new Error(`postgres exited before readiness: ${outcome.exitCode}`);
        if (!await terminateOwnedProcessTree(record, target.target.split(":")[0])) {
          throw new OperationalHarnessError("cleanup", `postgres process did not close after ${outcome.kind}: ${record.pid}`);
        }
        throw new OperationalHarnessError("start", `start ${outcome.kind === "timeout" ? "timed out" : "was cancelled"}`);
      }
      async createDatabase(name) {
        const client = new pg.Client({ database: "postgres", host: "127.0.0.1", password: this.options.password, port: this.options.port, user: this.options.user });
        await client.connect();
        try { await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`); } finally { await client.end(); }
      }
      async stop() {
        const records = [...this.activeProcesses];
        for (const record of records) {
          if (!await terminateOwnedProcessTree(record, target.target.split(":")[0])) {
            throw new OperationalHarnessError("cleanup", `owned PostgreSQL process did not close: ${record.pid}`);
          }
        }
        this.process = undefined;
      }
    };
  } catch (error) {
    throw new OperationalHarnessError("install-script", "embedded PostgreSQL package or hydrated binaries are unavailable", { cause: error });
  }
}

function binary(nativeRoot, name, suffix = platform() === "win32" ? ".exe" : "") {
  return join(nativeRoot, "bin", `${name}${suffix}`);
}

export async function runOwnedBinary(command, args, label, onLog, options = {}) {
  const platformName = options.platformName ?? platform();
  const child = spawn(command, args, {
    env: { ...process.env, LC_MESSAGES: "C" }, shell: false, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], ...resolveOwnedSpawnOptions(platformName)
  });
  const record = processRecord(child);
  options.onSpawn?.(record.pid);
  options.onProcess?.(record);
  let output = "";
  const inspect = (chunk) => { const message = chunk.toString(); output += message; onLog(message); };
  child.stdout.on("data", inspect); child.stderr.on("data", inspect);
  try {
    const outcome = await operationOutcome(undefined, record.terminal, options.signal, options.timeoutMs ?? 60_000);
    if (outcome.kind === "close" && outcome.exitCode === 0) return;
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "close") throw new Error(`${label} exited ${outcome.exitCode}: ${output}`);
    if (!await terminateOwnedProcessTree(record, platformName)) {
      throw new OperationalHarnessError("cleanup", `${label} process tree did not close: ${record.pid}`);
    }
    throw new OperationalHarnessError(label, `${label} ${outcome.kind === "timeout" ? "timed out" : "was cancelled"}`);
  } finally {
    options.onSettled?.(record);
  }
}

export function resolveOwnedSpawnOptions(platformName = platform()) {
  return { detached: platformName !== "win32" };
}

function processRecord(child) {
  const terminal = new Promise((resolveTerminal) => {
    child.once("error", (error) => resolveTerminal({ kind: "error", error }));
    child.once("close", (exitCode) => resolveTerminal({ kind: "close", exitCode: exitCode ?? -1 }));
  });
  return { child, pid: child.pid, terminal };
}

async function operationOutcome(ready, terminal, signal, timeoutMs) {
  let timer;
  let abortListener;
  const timeout = new Promise((resolveTimeout) => { timer = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs); });
  const candidates = [terminal, timeout];
  if (ready !== undefined) candidates.push(ready);
  if (signal !== undefined) {
    candidates.push(new Promise((resolveAbort) => {
      if (signal.aborted) { resolveAbort({ kind: "aborted" }); return; }
      abortListener = () => resolveAbort({ kind: "aborted" });
      signal.addEventListener("abort", abortListener, { once: true });
    }));
  }
  const outcome = await Promise.race(candidates);
  clearTimeout(timer);
  if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  return outcome;
}

async function terminateOwnedProcessTree(record, platformName = platform()) {
  if (!Number.isInteger(record.pid) || record.pid <= 0) return false;
  if (platformName === "win32") {
    const killer = spawn("taskkill", ["/pid", String(record.pid), "/f", "/t"], { shell: false, windowsHide: true, stdio: "ignore" });
    const killerTerminal = new Promise((resolveKiller) => {
      killer.once("error", () => resolveKiller(false));
      killer.once("close", () => resolveKiller(true));
    });
    if (!await boundedResult(killerTerminal, 2_000, false)) killer.kill();
    return boundedResult(record.terminal.then(() => true), 3_000, false);
  }
  if (!signalProcessGroup(record.pid, "SIGTERM") || await waitForProcessGroupExit(record.pid, 1_000)) return true;
  signalProcessGroup(record.pid, "SIGKILL");
  return waitForProcessGroupExit(record.pid, 3_000);
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return !processGroupExists(pid);
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function boundedResult(operation, timeoutMs, fallback) {
  let timer;
  const deadline = new Promise((resolveDeadline) => { timer = setTimeout(() => resolveDeadline(fallback), timeoutMs); });
  const result = await Promise.race([operation, deadline]);
  clearTimeout(timer);
  return result;
}

function ownedProcessIds(embedded) {
  if (embedded === undefined || typeof embedded.ownedProcessIds !== "function") return [];
  return [...new Set(embedded.ownedProcessIds().filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    return false;
  }
}

async function isLoopbackPortFree(port) {
  return new Promise((resolveFree) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveFree(true)));
  });
}

async function stage(name, operation, timeoutMs = 60_000) {
  const controller = new AbortController();
  let timeout;
  try {
    const operationResult = Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => ({ kind: "value", value }), (error) => ({ kind: "error", error })
    );
    const deadline = new Promise((resolveDeadline) => { timeout = setTimeout(() => resolveDeadline({ kind: "timeout" }), timeoutMs); });
    const first = await Promise.race([operationResult, deadline]);
    if (first.kind === "timeout") {
      controller.abort();
      await boundedResult(operationResult, 1_000, { kind: "cancellation-pending" });
      throw new OperationalHarnessError(name, `${name} timed out after ${timeoutMs}ms`);
    }
    if (first.kind === "error") throw first.error;
    return first.value;
  } catch (error) {
    if (error instanceof OperationalHarnessError) throw error;
    throw new OperationalHarnessError(name, `${name} failed`, { cause: error });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
