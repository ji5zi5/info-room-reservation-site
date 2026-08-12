// allow: SIZE_OK — immutable evidence recorder is one auditable state machine with a single CLI boundary.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const SLUG = "operational-fomo-upgrade";
const PLAN_SHA256 = "7e1e38d796376ce5bbea96178942bdb5faf171f20294abb2167b026269fabfe4";
const REVIEW_SHA256 = "3b932d07ec53a7095de0b644aad953f559c84c74d63e6e652ab1db08ec09c7a0";
const COMMANDS = ["init", "retro-start", "start", "run", "finalize", "integrate", "verify"];

export class EvidenceRecorderError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "EvidenceRecorderError";
    this.code = code;
  }
}

export function parseRecorderArguments(argv) {
  const command = z.enum(COMMANDS).parse(argv[0]);
  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv.slice(1) : argv.slice(1, separator);
  const childArgv = separator === -1 ? [] : argv.slice(separator + 1);
  const values = new Map();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) {
      throw new EvidenceRecorderError("ARGUMENT", "recorder flags require --name value pairs");
    }
    const entries = values.get(flag) ?? [];
    entries.push(value);
    values.set(flag, entries);
  }
  return { childArgv, command, values };
}

export async function runEvidenceWrapper(argv) {
  const phaseIndex = argv.indexOf("--phase");
  const attemptIndex = argv.indexOf("--attempt-dir");
  const phase = z.enum(["database", "browser", "discord", "full"]).parse(argv[phaseIndex + 1]);
  const attemptDir = resolve(z.string().min(1).parse(argv[attemptIndex + 1]));
  await validateAttempt(attemptDir);
  const { runOperationalCore } = await import("./operational-fomo-core.mjs");
  return runOperationalCore({ attemptDir, phase });
}

export async function executeRecorder(argv) {
  const parsed = parseRecorderArguments(argv);
  switch (parsed.command) {
    case "init": return initializeAttempt(parsed.values);
    case "retro-start": return startTask(parsed.values, true);
    case "start": return startTask(parsed.values, false);
    case "run": return runTaskCommand(parsed.values, parsed.childArgv);
    case "finalize": return finalizeTask(parsed.values);
    case "integrate": return integrateTask(parsed.values);
    case "verify": return verifyTask(parsed.values);
    default: throw new EvidenceRecorderError("ARGUMENT", "unsupported recorder command");
  }
}

export function validateApprovedReviewReceipt(reviewText, parent, parentTree) {
  const receipt = parseReviewReceipt(reviewText);
  if (sha256Text(reviewText) !== REVIEW_SHA256 || receipt.status !== "approved" || receipt.roundStatus !== "approved") {
    fail("REVIEW", "review receipt is not the frozen approved receipt");
  }
  if (receipt.executionBaseSha !== parent || receipt.executionBaseTreeSha !== parentTree ||
      receipt.momusReviewedHeadSha !== parent || receipt.independentReviewedHeadSha !== parent ||
      receipt.momusReviewedTreeSha !== parentTree || receipt.independentReviewedTreeSha !== parentTree ||
      !receipt.momusReviewedClean || !receipt.independentReviewedClean) {
    fail("BASE", "execution base does not equal both clean reviewer observations");
  }
  if (receipt.momusLaunchId === receipt.independentLaunchId || receipt.momusSessionId === receipt.independentSessionId) {
    fail("REVIEW", "reviewer launch and session identities must be distinct");
  }
  return receipt;
}

export function countBootstrapWorktrees(porcelain, commitSha) {
  return porcelain.split(/\r?\n/u).filter((line) => line === `HEAD ${commitSha}`).length;
}

async function initializeAttempt(values) {
  const attemptDir = absoluteFlag(values, "--attempt-dir");
  const sourceRoot = absoluteFlag(values, "--source-workspace");
  const boundPlanPath = absoluteFlag(values, "--bound-plan");
  const descriptorPath = absoluteFlag(values, "--descriptor");
  const reviewPath = absoluteFlag(values, "--review-receipt");
  await mkdir(attemptDir, { recursive: true });
  await rejectExisting(resolve(attemptDir, "attempt.json"));
  const [head, parent, parentTree, commitParents, clean] = await Promise.all([
    git(sourceRoot, ["rev-parse", "HEAD"]), git(sourceRoot, ["rev-parse", "HEAD^"]),
    git(sourceRoot, ["rev-parse", "HEAD^^{tree}"]), git(sourceRoot, ["show", "-s", "--format=%P", "HEAD"]),
    gitClean(sourceRoot)
  ]);
  if (!clean || commitParents.trim().split(/\s+/u).length !== 1) fail("BASE", "Todo 1 must be one clean non-merge commit");
  const reviewText = await readFile(reviewPath, "utf8");
  const receipt = validateApprovedReviewReceipt(reviewText, parent, parentTree);
  const [planDescriptor, reviewDescriptor, descriptorScript] = await Promise.all([
    descriptorRead(descriptorPath, sourceRoot, relative(sourceRoot, boundPlanPath)),
    descriptorRead(descriptorPath, sourceRoot, relative(sourceRoot, reviewPath)), fileIdentity(descriptorPath)
  ]);
  if (planDescriptor.target.sha256 !== PLAN_SHA256 || receipt.planSha256 !== PLAN_SHA256 ||
      reviewDescriptor.target.sha256 !== REVIEW_SHA256 || receipt.planPath !== ".omo/plans/operational-fomo-upgrade.md") {
    fail("DESCRIPTOR", "plan or review descriptor digest is not approved");
  }
  const attempt = {
    schemaVersion: 1, slug: SLUG, attemptBaseSha: parent, attemptBaseTreeSha: parentTree,
    todo1CommitSha: head, sourceWorkspaceRoot: sourceRoot, boundPlanPath,
    planDescriptorReceipt: planDescriptor, descriptorScript, reviewReceipt: { descriptor: reviewDescriptor, ...receipt },
    createdAt: new Date().toISOString()
  };
  await atomicJson(resolve(attemptDir, "attempt.json"), attempt);
  return attempt;
}

async function validateAttempt(attemptDir) {
  const attemptPath = resolve(attemptDir, "attempt.json");
  const attempt = JSON.parse(await readFile(attemptPath, "utf8"));
  const currentScript = await fileIdentity(attempt.descriptorScript.path);
  const [planDescriptor, reviewDescriptor] = await Promise.all([
    descriptorRead(attempt.descriptorScript.path, attempt.sourceWorkspaceRoot, relative(attempt.sourceWorkspaceRoot, attempt.boundPlanPath)),
    descriptorRead(attempt.descriptorScript.path, attempt.sourceWorkspaceRoot, relative(attempt.sourceWorkspaceRoot, attempt.reviewReceipt.descriptor.target.path))
  ]);
  if (stableJson(currentScript) !== stableJson(attempt.descriptorScript) ||
      stableJson(planDescriptor) !== stableJson(attempt.planDescriptorReceipt) ||
      stableJson(reviewDescriptor) !== stableJson(attempt.reviewReceipt.descriptor)) {
    fail("IDENTITY_DRIFT", "descriptor chain or descriptor script identity changed");
  }
  const currentReceipt = parseReviewReceipt(await readFile(attempt.reviewReceipt.descriptor.target.path, "utf8"));
  for (const key of Object.keys(currentReceipt)) {
    if (currentReceipt[key] !== attempt.reviewReceipt[key]) fail("IDENTITY_DRIFT", `review receipt field changed: ${key}`);
  }
  return attempt;
}

async function startTask(values, retrospective) {
  const attemptDir = absoluteFlag(values, "--attempt-dir");
  const todo = integerFlag(values, "--todo");
  const attempt = await validateAttempt(attemptDir);
  const workspace = process.cwd();
  if (!await gitClean(workspace)) fail("DIRTY", "task start requires a clean worktree");
  const files = await readdir(attemptDir);
  if (files.some((name) => name === taskStartName(todo) || name === manifestName(todo) || name === integrationName(todo))) {
    fail("EXISTS", "task evidence record already exists");
  }
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  const tree = await git(workspace, ["rev-parse", "HEAD^{tree}"]);
  const planText = await readFile(attempt.boundPlanPath, "utf8");
  const dependencies = parseDependencies(planText).get(todo) ?? [];
  const baselineTasks = await readBaseline(attemptDir);
  for (const dependency of dependencies) {
    const baseline = baselineTasks.find((entry) => entry.todo === dependency);
    if (baseline === undefined || !await isAncestor(workspace, baseline.commitSha, head)) {
      fail("DEPENDENCY", `Todo ${dependency} is not integrated in Todo ${todo}'s baseline`);
    }
  }
  let taskStartSha = head;
  let commitSha = null;
  if (retrospective) {
    if (todo !== 1 || head !== attempt.todo1CommitSha || await git(workspace, ["rev-parse", "HEAD^"]) !== attempt.attemptBaseSha) {
      fail("RETRO", "retrospective start is reserved for the exact Todo 1 bootstrap commit");
    }
    const count = await git(workspace, ["rev-list", "--count", `${attempt.attemptBaseSha}..HEAD`]);
    const parents = await git(workspace, ["show", "-s", "--format=%P", "HEAD"]);
    const worktrees = await git(workspace, ["worktree", "list", "--porcelain"]);
    if (count !== "1" || parents.split(/\s+/u).length !== 1 || countBootstrapWorktrees(worktrees, attempt.todo1CommitSha) !== 1 || baselineTasks.length !== 0) {
      fail("RETRO", "Todo 1 retrospective proof requires one commit, one worktree, and an empty baseline");
    }
    taskStartSha = attempt.attemptBaseSha;
    commitSha = head;
    await enforceWriteSet(planText, todo, await changedPaths(workspace, taskStartSha, commitSha));
  }
  const start = { schemaVersion: 1, todo, startMode: retrospective ? "retrospective_bootstrap" : "pre_edit", taskStartSha, baselineTasks, commitSha, tree };
  await atomicJson(resolve(attemptDir, taskStartName(todo)), start);
  return start;
}

async function runTaskCommand(values, childArgv) {
  const attemptDir = absoluteFlag(values, "--attempt-dir");
  const todo = integerFlag(values, "--todo");
  await validateAttempt(attemptDir);
  if (childArgv.length === 0) fail("ARGUMENT", "run requires a child command after --");
  if (!await gitClean(process.cwd())) fail("DIRTY", "command requires a clean worktree");
  const start = JSON.parse(await readFile(resolve(attemptDir, taskStartName(todo)), "utf8"));
  const commitSha = await git(process.cwd(), ["rev-parse", "HEAD"]);
  const testedTreeSha = await git(process.cwd(), ["rev-parse", "HEAD^{tree}"]);
  const commandRecordsPath = resolve(attemptDir, `task-${todo}-commands.json`);
  const existing = await readJsonOr(commandRecordsPath, []);
  const files = await readdir(attemptDir);
  const usedIndexes = files.flatMap((name) => {
    const match = new RegExp(`^task-${todo}-command-(\\d+)\\.log$`, "u").exec(name);
    return match?.[1] === undefined ? [] : [Number(match[1])];
  });
  const outputIndex = Math.max(existing.length, ...usedIndexes, 0) + 1;
  const outputPath = resolve(attemptDir, `task-${todo}-command-${outputIndex}.log`);
  const startedAt = new Date().toISOString();
  const result = await spawnCaptured(childArgv, outputPath, durationFlag(values, "--timeout-ms", 300_000));
  const cleanAfter = await gitClean(process.cwd());
  const record = {
    workingDirectory: resolve(process.cwd()), argv: childArgv, startedAt, finishedAt: new Date().toISOString(),
    exitCode: result.exitCode, timedOut: result.timedOut, commitSha, testedTreeSha, cleanBefore: true, cleanAfter,
    outputPath, outputSha256: await sha256File(outputPath)
  };
  await replaceJson(commandRecordsPath, [...existing, record]);
  if (!cleanAfter || await git(process.cwd(), ["rev-parse", "HEAD"]) !== commitSha ||
      await git(process.cwd(), ["rev-parse", "HEAD^{tree}"]) !== testedTreeSha) fail("DIRTY", "child changed the tested tree");
  if (result.timedOut) fail("TIMEOUT", "child command exceeded its bounded deadline");
  if (result.exitCode !== 0) fail("CHILD", `child command failed with exit ${result.exitCode}`);
  if (start.startMode === "retrospective_bootstrap" && commitSha !== start.commitSha) fail("COMMIT", "Todo 1 commit changed after retro-start");
  return record;
}

async function finalizeTask(values) {
  const attemptDir = absoluteFlag(values, "--attempt-dir");
  const todo = integerFlag(values, "--todo");
  const evidencePaths = values.get("--evidence") ?? [];
  const attempt = await validateAttempt(attemptDir);
  if (!await gitClean(process.cwd())) fail("DIRTY", "finalize requires a clean worktree");
  const start = JSON.parse(await readFile(resolve(attemptDir, taskStartName(todo)), "utf8"));
  const commitSha = await git(process.cwd(), ["rev-parse", "HEAD"]);
  const testedTreeSha = await git(process.cwd(), ["rev-parse", "HEAD^{tree}"]);
  const count = await git(process.cwd(), ["rev-list", "--count", `${start.taskStartSha}..${commitSha}`]);
  const parent = await git(process.cwd(), ["rev-parse", `${commitSha}^`]);
  if (count !== "1" || parent !== start.taskStartSha) fail("COMMIT", "task must contain exactly one commit on its start SHA");
  const planText = await readFile(attempt.boundPlanPath, "utf8");
  const paths = await changedPaths(process.cwd(), start.taskStartSha, commitSha);
  await enforceWriteSet(planText, todo, paths);
  const commands = await readJsonOr(resolve(attemptDir, `task-${todo}-commands.json`), []);
  if (commands.length === 0 || commands.some((item) => item.exitCode !== 0 || !item.cleanBefore || !item.cleanAfter || item.commitSha !== commitSha || item.testedTreeSha !== testedTreeSha)) {
    fail("COMMAND", "finalize requires passing commands on the clean committed tree");
  }
  const evidence = [];
  for (const supplied of evidencePaths) {
    const path = resolve(supplied);
    ensureInside(attemptDir, path);
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0) fail("EVIDENCE", `evidence is missing or empty: ${path}`);
    evidence.push({ path, kind: path.endsWith(".png") ? "image" : "text", sha256: await sha256File(path) });
  }
  if (!evidence.some((item) => item.path.endsWith(".txt"))) fail("EVIDENCE", "a non-empty task narrative .txt is required");
  const manifest = {
    schemaVersion: 1, planSha256: PLAN_SHA256, attemptBaseSha: attempt.attemptBaseSha, todo,
    startMode: start.startMode, taskStartSha: start.taskStartSha, baselineTasks: start.baselineTasks,
    commitSha, testedTreeSha, status: "passed", commands, evidence, changedPaths: paths
  };
  await atomicJson(resolve(attemptDir, manifestName(todo)), manifest);
  return manifest;
}

async function integrateTask(values) {
  const attemptDir = absoluteFlag(values, "--attempt-dir");
  const todo = integerFlag(values, "--todo");
  await validateAttempt(attemptDir);
  const integrationCommit = singleFlag(values, "--integration-commit");
  const manifest = JSON.parse(await readFile(resolve(attemptDir, manifestName(todo)), "utf8"));
  await verifyManifestEvidence(attemptDir, manifest);
  if (!await isAncestor(process.cwd(), manifest.commitSha, integrationCommit)) fail("INTEGRATION", "task commit is not integrated");
  const mode = todo === 1 ? "serial_bootstrap" : "no_ff_merge";
  if (todo === 1 && integrationCommit !== manifest.commitSha) fail("INTEGRATION", "Todo 1 integration SHA must equal its task SHA");
  if (todo !== 1) {
    const parents = (await git(process.cwd(), ["show", "-s", "--format=%P", integrationCommit])).split(/\s+/u);
    if (parents.length < 2 || !await isAncestor(process.cwd(), manifest.commitSha, parents[1])) fail("INTEGRATION", "integration commit is not the required no-ff merge");
  }
  const receipt = { schemaVersion: 1, todo, mode, taskCommitSha: manifest.commitSha, integrationCommitSha: integrationCommit, integratedTreeSha: await git(process.cwd(), ["rev-parse", `${integrationCommit}^{tree}`]) };
  receipt.manifestSha256 = await sha256File(resolve(attemptDir, manifestName(todo)));
  await atomicJson(resolve(attemptDir, integrationName(todo)), receipt);
  return receipt;
}

async function verifyTask(values) {
  const attemptDir = absoluteFlag(values, "--attempt-dir");
  const todo = integerFlag(values, "--todo");
  await validateAttempt(attemptDir);
  const manifestPath = resolve(attemptDir, manifestName(todo));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const integration = await readJsonOr(resolve(attemptDir, integrationName(todo)), null);
  if (integration !== null && integration.manifestSha256 !== await sha256File(manifestPath)) {
    fail("EVIDENCE_MUTATION", "finalized manifest changed after integration");
  }
  await verifyManifestEvidence(attemptDir, manifest);
  return { schemaVersion: 1, todo, commitSha: manifest.commitSha, testedTreeSha: manifest.testedTreeSha, evidence: manifest.evidence, status: "verified" };
}

export async function verifyManifestEvidence(attemptDir, manifest) {
  const hashedFiles = [
    ...manifest.commands.map((item) => ({ path: item.outputPath, sha256: item.outputSha256 })),
    ...manifest.evidence
  ];
  for (const item of hashedFiles) {
    const path = resolve(item.path);
    ensureInside(attemptDir, path);
    let metadata;
    try { metadata = await stat(path); } catch (error) {
      throw new EvidenceRecorderError("EVIDENCE_MUTATION", `finalized evidence is missing: ${path}`, { cause: error });
    }
    const currentSha256 = await sha256File(path);
    if (!metadata.isFile() || currentSha256 !== item.sha256) {
      fail("EVIDENCE_MUTATION", `finalized evidence changed after hashing: ${path} expected=${item.sha256} actual=${currentSha256}`);
    }
  }
  return true;
}

function parseReviewReceipt(text) {
  const launches = [...text.matchAll(/^\s+launch_id:\s*(\S+)$/gmu)].map((match) => match[1]);
  const sessions = [...text.matchAll(/^\s+session:\s*(\S+)$/gmu)].map((match) => match[1]);
  return {
    roundId: field(text, "review_round_id"), status: field(text, "status"), roundStatus: field(text, "round_status"),
    planPath: field(text, "plan_path"), planSha256: field(text, "plan_sha256"),
    momusLaunchId: launches[0], momusSessionId: sessions[0], independentLaunchId: launches[1], independentSessionId: sessions[1],
    momusReviewedHeadSha: field(text, "momusReviewedHeadSha"), momusReviewedTreeSha: field(text, "momusReviewedTreeSha"),
    momusReviewedClean: field(text, "momusReviewedClean") === "true",
    independentReviewedHeadSha: field(text, "independentReviewedHeadSha"), independentReviewedTreeSha: field(text, "independentReviewedTreeSha"),
    independentReviewedClean: field(text, "independentReviewedClean") === "true",
    executionBaseSha: field(text, "executionBaseSha"), executionBaseTreeSha: field(text, "executionBaseTreeSha")
  };
}

async function descriptorRead(script, root, target) {
  const normalized = target.split(sep).join("/");
  const output = await spawnText([process.platform === "win32" ? "py" : "python3", script, root, normalized]);
  const value = JSON.parse(output);
  return {
    canonicalRoot: value.canonical_root, ancestors: value.ancestors.map((item) => ({ segment: item.segment, volume: item.volume, fileIndex: item.file_index })),
    target: { path: resolve(root, value.target), regularFile: value.regular_file, volume: value.volume, fileIndex: value.file_index, sha256: value.sha256 }
  };
}

async function fileIdentity(path) {
  const metadata = await stat(path, { bigint: true });
  return { path: resolve(path), sha256: await sha256File(path), volume: metadata.dev.toString(), fileIndex: metadata.ino.toString() };
}

function parseWriteSets(planText) {
  const sets = new Map();
  for (const match of planText.matchAll(/^\|\s*(\d+)\s*\|\s*((?:`[^`]+`;?\s*)+)\|$/gmu)) {
    sets.set(Number(match[1]), [...match[2].matchAll(/`([^`]+)`/gu)].map((path) => path[1]));
  }
  return sets;
}

function parseDependencies(planText) {
  const dependencies = new Map();
  for (const match of planText.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+)\|/gmu)) {
    const todo = Number(match[1]);
    const raw = match[2].trim();
    const values = raw === "none" ? [] : expandNumbers(raw);
    dependencies.set(todo, values);
  }
  return dependencies;
}

function expandNumbers(raw) {
  const output = [];
  for (const part of raw.split(",").map((value) => value.trim())) {
    const range = /^(\d+)-(\d+)$/u.exec(part);
    if (range === null) output.push(Number(part));
    else for (let value = Number(range[1]); value <= Number(range[2]); value += 1) output.push(value);
  }
  return output.filter(Number.isInteger);
}

async function enforceWriteSet(planText, todo, paths) {
  const declared = parseWriteSets(planText).get(todo);
  if (declared === undefined) fail("WRITE_SET", `Todo ${todo} has no declared write set`);
  const invalid = paths.filter((path) => !declared.some((pattern) => pattern.endsWith("/**") ? path.startsWith(pattern.slice(0, -3)) : path === pattern));
  if (invalid.length > 0) fail("WRITE_SET", `undeclared changed paths: ${invalid.join(", ")}`);
}

async function readBaseline(attemptDir) {
  const files = (await readdir(attemptDir)).filter((name) => /^task-\d+-integration\.json$/u.test(name)).sort();
  return Promise.all(files.map(async (name) => {
    const receipt = JSON.parse(await readFile(resolve(attemptDir, name), "utf8"));
    return { todo: receipt.todo, commitSha: receipt.taskCommitSha };
  }));
}

async function spawnCaptured(argv, outputPath, timeoutMs) {
  const { command, args } = resolveSpawnInvocation(argv[0], argv.slice(1));
  const file = await open(outputPath, "wx");
  let writes = Promise.resolve();
  const capture = (stream, chunk) => {
    stream.write(chunk);
    writes = writes.then(async () => { await file.write(chunk); });
  };
  try {
    return await runOwnedProcess(command, args, {
      timeoutMs,
      onStderr: (chunk) => capture(process.stderr, chunk),
      onStdout: (chunk) => capture(process.stdout, chunk)
    });
  } finally {
    await writes;
    await file.sync();
    await file.close();
  }
}

async function spawnText(argv) {
  const { command, args } = resolveSpawnInvocation(argv[0], argv.slice(1));
  let stdout = ""; let stderr = "";
  const result = await runOwnedProcess(command, args, {
    timeoutMs: 30_000,
    onStderr: (chunk) => { stderr += chunk.toString(); },
    onStdout: (chunk) => { stdout += chunk.toString(); }
  });
  if (result.timedOut) fail("TIMEOUT", `bounded helper timed out: ${argv[0]}`);
  if (result.exitCode !== 0) fail("CHILD", stderr.trim() || `exit ${result.exitCode}`);
  return stdout.trim();
}

export function resolveSpawnInvocation(command, args, platform = process.platform, commandProcessor = process.env.ComSpec ?? "cmd.exe") {
  if (platform === "win32" && ["npm", "npx"].includes(command)) {
    return { command: commandProcessor, args: ["/d", "/s", "/c", command, ...args] };
  }
  return { command, args };
}

export function resolveSpawnOptions(platformName = process.platform) {
  return { detached: platformName !== "win32" };
}

async function runOwnedProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: process.cwd(), env: process.env, shell: false, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], ...resolveSpawnOptions()
  });
  child.stdout.on("data", options.onStdout);
  child.stderr.on("data", options.onStderr);
  const terminal = new Promise((resolveTerminal) => {
    child.once("error", (error) => resolveTerminal({ kind: "error", error }));
    child.once("close", (exitCode) => resolveTerminal({ kind: "close", exitCode: exitCode ?? -1 }));
  });
  let timer;
  const deadline = new Promise((resolveDeadline) => { timer = setTimeout(() => resolveDeadline({ kind: "timeout" }), options.timeoutMs); });
  const first = await Promise.race([terminal, deadline]);
  clearTimeout(timer);
  if (first.kind === "error") throw new EvidenceRecorderError("CHILD", "child failed to start", { cause: first.error });
  if (first.kind === "close") return { exitCode: first.exitCode, timedOut: false };
  const closed = await terminateProcessTree(child.pid, terminal);
  if (!closed) fail("CLEANUP", `owned child process tree did not close after timeout: ${child.pid ?? "unknown"}`);
  return { exitCode: -1, timedOut: true };
}

async function terminateProcessTree(pid, terminal, platformName = process.platform) {
  if (pid === undefined) return false;
  if (platformName === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { shell: false, windowsHide: true, stdio: "ignore" });
    const killerTerminal = new Promise((resolveKill) => {
      killer.once("error", () => resolveKill(false));
      killer.once("close", () => resolveKill(true));
    });
    if (!await boundedBoolean(killerTerminal, 5_000)) killer.kill();
    return boundedBoolean(terminal.then(() => true), 5_000);
  }
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  if (await boundedBoolean(terminal.then(() => true), 1_000)) return true;
  try { process.kill(-pid, "SIGKILL"); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
  return boundedBoolean(terminal.then(() => true), 4_000);
}

async function boundedBoolean(operation, timeoutMs) {
  let timer;
  const deadline = new Promise((resolveDeadline) => { timer = setTimeout(() => resolveDeadline(false), timeoutMs); });
  const result = await Promise.race([operation, deadline]);
  clearTimeout(timer);
  return result;
}

async function atomicJson(path, value) {
  await rejectExisting(path);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx");
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, path); } catch (error) { await unlink(temporary); throw new EvidenceRecorderError("EXISTS", `immutable record already exists: ${path}`, { cause: error }); }
  await unlink(temporary);
  await flushDirectory(resolve(path, ".."));
}

async function replaceJson(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx");
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path); await flushDirectory(resolve(path, ".."));
}

async function flushDirectory(path) {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function git(cwd, args) { return spawnText(["git", "-C", cwd, ...args]); }
async function gitClean(cwd) { return (await git(cwd, ["status", "--porcelain", "--untracked-files=all"])) === ""; }
async function changedPaths(cwd, from, to) { const text = await git(cwd, ["diff", "--name-only", `${from}..${to}`]); return text === "" ? [] : text.split(/\r?\n/u); }
async function isAncestor(cwd, ancestor, descendant) { try { await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; } }
async function sha256File(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function sha256Text(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function field(text, name) { const match = new RegExp(`^${name}:\\s*(.+)$`, "mu").exec(text); if (match?.[1] === undefined) fail("REVIEW", `missing receipt field ${name}`); return match[1].trim(); }
function singleFlag(values, name) { const value = values.get(name)?.[0]; if (value === undefined) fail("ARGUMENT", `missing ${name}`); return value; }
function absoluteFlag(values, name) { const raw = singleFlag(values, name); if (!isAbsolute(raw)) fail("ARGUMENT", `${name} must be absolute`); return resolve(raw); }
function integerFlag(values, name) { return z.coerce.number().int().min(1).max(21).parse(singleFlag(values, name)); }
function durationFlag(values, name, fallback) {
  const raw = values.get(name)?.[0];
  return raw === undefined ? fallback : z.coerce.number().int().min(10).max(600_000).parse(raw);
}
function taskStartName(todo) { return `task-${todo}-start.json`; }
function manifestName(todo) { return `task-${todo}-${SLUG}.manifest.json`; }
function integrationName(todo) { return `task-${todo}-integration.json`; }
async function readJsonOr(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return fallback; throw error; } }
async function rejectExisting(path) { try { await access(path); fail("EXISTS", `immutable record already exists: ${path}`); } catch (error) { if (error instanceof EvidenceRecorderError) throw error; if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; } }
function ensureInside(root, path) { const rel = relative(resolve(root), resolve(path)); if (rel.startsWith("..") || isAbsolute(rel)) fail("EVIDENCE", "evidence must be inside attemptDir"); }
function fail(code, message) { throw new EvidenceRecorderError(code, message); }

const entryPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (entryPath === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const operation = argv[0]?.startsWith("--") ? runEvidenceWrapper(argv) : executeRecorder(argv);
  operation.then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
