import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const RECORDER = resolve("scripts", "run-operational-fomo-evidence.mjs");
const roots: string[] = [];

interface CliResult { readonly status: number | null; readonly stderr: string; readonly stdout: string }
interface Fixture { readonly attempt: string; readonly base: string; readonly descriptor: string; readonly head: string; readonly plan: string; readonly recorder: string; readonly repo: string; readonly review: string }

function runRecorder(source: string): unknown {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import * as recorder from ${JSON.stringify(pathToFileURL(RECORDER).href)};
    ${source}
  `], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function git(repo: string, ...args: readonly string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function cli(repo: string, ...args: readonly string[]): CliResult {
  const result = spawnSync(process.execPath, [join(repo, "scripts", "run-operational-fomo-evidence.mjs"), ...args], { cwd: repo, encoding: "utf8", timeout: 20_000 });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

async function sha(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function identity(path: string): Promise<{ path: string; sha256: string; volume: string; fileIndex: string }> {
  const metadata = await stat(path, { bigint: true });
  return { path: resolve(path), sha256: await sha(path), volume: metadata.dev.toString(), fileIndex: metadata.ino.toString() };
}

async function fixture(changedPath = "allowed.txt", plan = "| 1 | `allowed.txt` |\n"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "fomo-recorder-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const attempt = join(root, "attempt");
  const identityRoot = join(repo, ".identity");
  const scriptsRoot = join(repo, "scripts");
  await mkdir(identityRoot, { recursive: true });
  await mkdir(scriptsRoot);
  await mkdir(attempt);
  git(repo, "init");
  git(repo, "config", "user.email", "qa@example.test");
  git(repo, "config", "user.name", "QA");
  await writeFile(join(repo, ".gitignore"), ".identity/\nnode_modules/\n");
  const recorder = join(scriptsRoot, "run-operational-fomo-evidence.mjs");
  await copyFile(RECORDER, recorder);
  await symlink(resolve("node_modules"), join(repo, "node_modules"), "junction");
  await writeFile(join(repo, "allowed.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, changedPath), "task\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "task");
  const head = git(repo, "rev-parse", "HEAD");
  const planPath = join(identityRoot, "plan.md");
  const review = join(identityRoot, "review.md");
  const descriptor = join(identityRoot, "descriptor.py");
  await writeFile(planPath, plan);
  await writeFile(review, `status: approved\nround_status: approved\nreview_round_id: r\nplan_path: plan.md\nplan_sha256: p\nexecutionBaseSha: ${base}\nexecutionBaseTreeSha: t\nmomusReviewedHeadSha: ${base}\nmomusReviewedTreeSha: t\nmomusReviewedClean: true\nindependentReviewedHeadSha: ${base}\nindependentReviewedTreeSha: t\nindependentReviewedClean: true\n  launch_id: m\n  session: ms\n  launch_id: i\n  session: is\n`);
  await writeFile(descriptor, "import hashlib,json,os,sys\nroot=os.path.realpath(sys.argv[1]); target=sys.argv[2].replace('/',os.sep); path=os.path.realpath(os.path.join(root,target)); parent=os.path.dirname(path); ancestors=[]\nfor segment in os.path.relpath(parent,root).split(os.sep):\n p=os.path.join(root,*[x['segment'] for x in ancestors],segment); s=os.stat(p); ancestors.append({'segment':segment,'volume':s.st_dev,'file_index':s.st_ino})\ns=os.stat(path); print(json.dumps({'canonical_root':root,'ancestors':ancestors,'target':os.path.relpath(path,root),'regular_file':os.path.isfile(path),'volume':s.st_dev,'file_index':s.st_ino,'sha256':hashlib.sha256(open(path,'rb').read()).hexdigest()}))\n");
  const describe = (target: string): unknown => {
    const executable = process.platform === "win32" ? "py" : "python3";
    const result = spawnSync(executable, [descriptor, repo, target], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
    const value = JSON.parse(result.stdout) as { canonical_root: string; ancestors: { segment: string; volume: number; file_index: number }[]; target: string; regular_file: boolean; volume: number; file_index: number; sha256: string };
    return { canonicalRoot: value.canonical_root, ancestors: value.ancestors.map((item) => ({ segment: item.segment, volume: item.volume, fileIndex: item.file_index })), target: { path: resolve(repo, value.target), regularFile: value.regular_file, volume: value.volume, fileIndex: value.file_index, sha256: value.sha256 } };
  };
  const receiptFields = { roundId: "r", status: "approved", roundStatus: "approved", planPath: "plan.md", planSha256: "p", momusLaunchId: "m", momusSessionId: "ms", independentLaunchId: "i", independentSessionId: "is", momusReviewedHeadSha: base, momusReviewedTreeSha: "t", momusReviewedClean: true, independentReviewedHeadSha: base, independentReviewedTreeSha: "t", independentReviewedClean: true, executionBaseSha: base, executionBaseTreeSha: "t" };
  await writeFile(join(attempt, "attempt.json"), `${JSON.stringify({ schemaVersion: 1, slug: "operational-fomo-upgrade", attemptBaseSha: base, attemptBaseTreeSha: "t", todo1CommitSha: head, sourceWorkspaceRoot: repo, boundPlanPath: planPath, planDescriptorReceipt: describe(".identity/plan.md"), descriptorScript: await identity(descriptor), reviewReceipt: { descriptor: describe(".identity/review.md"), ...receiptFields }, createdAt: new Date().toISOString() }, null, 2)}\n`);
  await writeFile(join(attempt, "task-1-start.json"), `${JSON.stringify({ schemaVersion: 1, todo: 1, startMode: "retrospective_bootstrap", taskStartSha: base, baselineTasks: [], commitSha: head, tree: git(repo, "rev-parse", "HEAD^{tree}") })}\n`);
  return { attempt, base, descriptor, head, plan: planPath, recorder, repo, review };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("operational FOMO immutable recorder", () => {
  it("is self-contained in a clean checkout and rejects unapproved receipt text", () => {
    const result = runRecorder(`let code;try{recorder.validateApprovedReviewReceipt('invalid','a','b')}catch(error){code=error.code}console.log(JSON.stringify(code))`);
    expect(result).toBe("REVIEW");
  });

  it("keeps child argv separate and selects process-group ownership by platform", () => {
    const result = runRecorder(`console.log(JSON.stringify({argv:recorder.parseRecorderArguments(['run','--todo','1','--attempt-dir','C:\\\\attempt','--','npm','test']).childArgv,linux:recorder.resolveSpawnOptions('linux'),spawn:recorder.resolveSpawnInvocation('npm',['test'],'win32','cmd.exe'),windows:recorder.resolveSpawnOptions('win32')}))`);
    expect(result).toEqual({ argv: ["npm", "test"], linux: { detached: true }, spawn: { command: "cmd.exe", args: ["/d", "/s", "/c", "npm", "test"] }, windows: { detached: false } });
  });

  it("fails closed at the recorder deadline and removes the owned child tree", async () => {
    const value = await fixture();
    const marker = join(value.attempt, "grandchild.pid");
    const program = "const{spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(process.argv[1],String(c.pid));setTimeout(()=>process.exit(0),300)";
    const result = cli(value.repo, "run", "--todo", "1", "--attempt-dir", value.attempt, "--timeout-ms", "50", "--", process.execPath, "-e", program, marker);
    const records = JSON.parse(await readFile(join(value.attempt, "task-1-commands.json"), "utf8")) as { exitCode: number; timedOut?: boolean }[];
    const pid = Number(await readFile(marker, "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) {
      const cleanup = process.platform === "win32"
        ? spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { encoding: "utf8" })
        : spawnSync("kill", ["-KILL", String(pid)], { encoding: "utf8" });
      expect(cleanup.status).toBe(0);
    }
    expect({ alive, status: result.status, record: records[0] }).toEqual({
      alive: false,
      status: 1,
      record: expect.objectContaining({ exitCode: -1, timedOut: true })
    });
  }, 30_000);

  it("records failed commands and recovers after an interrupted orphan log", async () => {
    const value = await fixture();
    expect(value.recorder.startsWith(value.repo)).toBe(true);
    await writeFile(join(value.attempt, "task-1-command-1.log"), "interrupted\n");
    const failed = cli(value.repo, "run", "--todo", "1", "--attempt-dir", value.attempt, "--", process.execPath, "-e", "process.exit(7)");
    expect(failed.status).toBe(1);
    const records = JSON.parse(await readFile(join(value.attempt, "task-1-commands.json"), "utf8")) as { exitCode: number; outputPath: string }[];
    expect(records).toEqual([expect.objectContaining({ exitCode: 7, outputPath: expect.stringContaining("command-2.log") })]);
  }, 30_000);

  it("rejects dirty and stale tested trees plus descriptor replacement", async () => {
    const dirty = await fixture();
    await writeFile(join(dirty.repo, "dirty.txt"), "dirty");
    expect(cli(dirty.repo, "run", "--todo", "1", "--attempt-dir", dirty.attempt, "--", process.execPath, "-e", "process.exit(0)").stderr).toContain("DIRTY");

    const stale = await fixture();
    expect(cli(stale.repo, "run", "--todo", "1", "--attempt-dir", stale.attempt, "--", process.execPath, "-e", "process.exit(0)").status).toBe(0);
    await writeFile(join(stale.repo, "allowed.txt"), "third\n"); git(stale.repo, "add", "."); git(stale.repo, "commit", "-m", "stale");
    await writeFile(join(stale.attempt, "evidence.txt"), "evidence");
    expect(cli(stale.repo, "finalize", "--todo", "1", "--attempt-dir", stale.attempt, "--evidence", join(stale.attempt, "evidence.txt")).status).toBe(1);

    const replaced = await fixture();
    const bytes = await readFile(replaced.review); await rm(replaced.review); await writeFile(replaced.review, bytes);
    expect(cli(replaced.repo, "run", "--todo", "1", "--attempt-dir", replaced.attempt, "--", process.execPath, "-e", "process.exit(0)").stderr).toContain("IDENTITY_DRIFT");
  }, 30_000);

  it("enforces write sets and dependency ancestry", async () => {
    const writeSet = await fixture("forbidden.txt");
    await writeFile(join(writeSet.attempt, "evidence.txt"), "evidence");
    expect(cli(writeSet.repo, "finalize", "--todo", "1", "--attempt-dir", writeSet.attempt, "--evidence", join(writeSet.attempt, "evidence.txt")).stderr).toContain("WRITE_SET");

    const dependency = await fixture("allowed.txt", "| 2 | `allowed.txt` |\n| 2 | 1 | dependency |\n");
    await rm(join(dependency.attempt, "task-1-start.json"));
    await writeFile(join(dependency.attempt, "task-1-integration.json"), JSON.stringify({ todo: 1, taskCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    expect(cli(dependency.repo, "start", "--todo", "2", "--attempt-dir", dependency.attempt).stderr).toContain("DEPENDENCY");
  }, 30_000);

  it("finalizes and integrates atomically and refuses create-once overwrites", async () => {
    const value = await fixture();
    const duplicateInit = cli(value.repo, "init", "--attempt-dir", value.attempt, "--source-workspace", value.repo, "--bound-plan", value.plan, "--descriptor", value.descriptor, "--review-receipt", value.review);
    expect(duplicateInit.stderr).toContain("EXISTS");
    expect(cli(value.repo, "run", "--todo", "1", "--attempt-dir", value.attempt, "--", process.execPath, "-e", "console.log('pass')").status).toBe(0);
    const evidence = join(value.attempt, "evidence.txt"); await writeFile(evidence, "evidence");
    expect(cli(value.repo, "finalize", "--todo", "1", "--attempt-dir", value.attempt, "--evidence", evidence).status).toBe(0);
    expect(cli(value.repo, "finalize", "--todo", "1", "--attempt-dir", value.attempt, "--evidence", evidence).status).toBe(1);
    expect(cli(value.repo, "integrate", "--todo", "1", "--attempt-dir", value.attempt, "--integration-commit", value.head).status).toBe(0);
    expect(cli(value.repo, "integrate", "--todo", "1", "--attempt-dir", value.attempt, "--integration-commit", value.head).status).toBe(1);
  }, 30_000);

  it("detects finalized evidence mutation before and after integration", async () => {
    const before = await fixture();
    expect(cli(before.repo, "run", "--todo", "1", "--attempt-dir", before.attempt, "--", process.execPath, "-e", "process.exit(0)").status).toBe(0);
    const beforeEvidence = join(before.attempt, "evidence.txt"); await writeFile(beforeEvidence, "original");
    expect(cli(before.repo, "finalize", "--todo", "1", "--attempt-dir", before.attempt, "--evidence", beforeEvidence).status).toBe(0);
    await writeFile(beforeEvidence, "mutated");
    expect(cli(before.repo, "integrate", "--todo", "1", "--attempt-dir", before.attempt, "--integration-commit", before.head).stderr).toContain("EVIDENCE_MUTATION");

    const after = await fixture();
    expect(cli(after.repo, "run", "--todo", "1", "--attempt-dir", after.attempt, "--", process.execPath, "-e", "process.exit(0)").status).toBe(0);
    const afterEvidence = join(after.attempt, "evidence.txt"); await writeFile(afterEvidence, "original");
    expect(cli(after.repo, "finalize", "--todo", "1", "--attempt-dir", after.attempt, "--evidence", afterEvidence).status).toBe(0);
    const integrated = cli(after.repo, "integrate", "--todo", "1", "--attempt-dir", after.attempt, "--integration-commit", after.head);
    expect(integrated.status, integrated.stderr).toBe(0);
    await writeFile(afterEvidence, "mutated");
    expect(cli(after.repo, "verify", "--todo", "1", "--attempt-dir", after.attempt).stderr).toContain("EVIDENCE_MUTATION");
  }, 30_000);

  it("rejects relative attempt directories before resolving them", () => {
    const result = spawnSync(process.execPath, [RECORDER, "retro-start", "--todo", "1", "--attempt-dir", "relative"], { encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stderr).toContain("must be absolute");
  });
});
