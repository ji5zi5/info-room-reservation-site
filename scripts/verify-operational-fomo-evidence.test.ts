// allow: SIZE_OK — CLI integration fixtures intentionally build the complete 21-task evidence graph.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const verifier = join(process.cwd(), "scripts", "verify-operational-fomo-evidence.mjs");
const sha256Pattern = /^[a-f0-9]{64}$/u;
let fixture: EvidenceFixture;

type EvidenceFixture = {
  readonly attemptDir: string;
  readonly planPath: string;
  readonly root: string;
  readonly workspace: string;
};

describe("operational FOMO evidence verifier CLI", () => {
  beforeAll(() => {
    fixture = createEvidenceFixture();
  }, 30_000);

  afterAll(() => {
    rmSync(fixture.root, { force: true, recursive: true });
  });

  it("owns both package QA modes and the permanent tracked-only CI command", () => {
    // Given
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const implementation = readFileSync(verifier, "utf8");
    const predeploy = readFileSync(join(process.cwd(), "scripts", "predeploy-check.ts"), "utf8");

    // When
    const routes = [pkg.scripts["qa:operational"], pkg.scripts["qa:operational:core"]];

    // Then
    expect(routes).toEqual([
      "node scripts/verify-operational-fomo-evidence.mjs --mode attempt",
      "node scripts/verify-operational-fomo-evidence.mjs --mode core"
    ]);
    expect(workflow.match(/npm run qa:operational:core -- --phase full --ci/gu)).toHaveLength(1);
    expect(workflow).toContain("EVIDENCE_DIR: ${{ runner.temp }}/operational-fomo-browser-evidence");
    expect(workflow).toContain("actions/upload-artifact@v5");
    expect(workflow).not.toMatch(/^\s+services:/mu);
    expect(implementation).not.toContain('"./operational-fomo-core.mjs"');
    expect(implementation).not.toContain('"scripts/verify-operational-fomo-evidence.test.ts"');
    expect(indexesInOrder(implementation, [
      '["test"]',
      '"test:integration"',
      '["run", "build"]',
      '["run", "vercel-build"]',
      "runDiscordPhase(env)",
      "runBrowserPhase(childArgv, ci, attemptDir)"
    ])).toBe(true);
    expect(implementation).toMatch(/const testEnv = \{ \.\.\.process\.env, NODE_ENV: "test" \}[\s\S]*delete testEnv\[key\]/u);
    expect(implementation).toContain(
      '["DATABASE_URL", "DEPLOYMENT_SHA", "DIRECT_URL", "EVIDENCE_DIR", "GITHUB_SHA", "INTEGRATION_DATABASE_URL", "VERCEL_GIT_COMMIT_SHA"]'
    );
    expect(implementation).toMatch(/INTEGRATION_DATABASE_URL: await configureRuntimeIntegrationUrl\(databaseUrl\)/u);
    expect(implementation).toMatch(/configureRuntimeIntegrationUrl[\s\S]*ALTER ROLE info_room_runtime/u);
    expect(implementation.match(/\["run", "vercel-build"\]/gu)).toHaveLength(1);
    expect(implementation).toMatch(/runDiscordPhase[\s\S]*runBrowserPhase[\s\S]*snapshotGeneratedArtifacts/u);
    expect(implementation).toContain('if (phase === "browser") return await runBrowserPhase(childArgv, ci, attemptDir);');
    expect(implementation).toMatch(/stopOwnedChild[\s\S]*waitForProcessGroupExit[\s\S]*SIGKILL/u);
    expect(implementation).toContain("browser process group could not be terminated");
    expect(implementation).toMatch(/case "attempt"[\s\S]*validateAttemptIdentity\(attemptDir\)[\s\S]*runPortableCore\(options\.phase, options\.childArgv, false, attemptDir\)/u);
    expect(implementation).toMatch(/resolveBrowserEvidenceRoot[\s\S]*owned: attemptDir === undefined[\s\S]*EVIDENCE_DIR: evidenceRoot/u);
    expect(implementation).toContain('["npm", "npm.cmd", "npx", "npx.cmd"]');
    expect(implementation).toContain("process.exit(1)");
    expect(implementation).not.toContain("process.exitCode = 1");
    expect(predeploy).toContain("permanent single-core CI/package contract");
  });

  it("reports all executable compliance invariants for a complete 21-task attempt", () => {
    // Given
    const args = ["--mode", "compliance", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace];

    // When
    const result = runVerifier(args);

    // Then
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("21/21 task manifests");
    expect(result.stdout).toContain("21/21 integration receipts");
    expect(result.stdout).toContain("undeclaredPaths=0");
    expect(result.stdout).toContain("parallelWriteSetIntersections=0");
    expect(result.stdout).toContain("missingGuardrailOutcomes=0");
  }, 30_000);

  it("fails closed when a clean-command artifact changes after finalization", () => {
    // Given
    const outputPath = join(fixture.attemptDir, "task-7-command-1.log");
    const original = readFileSync(outputPath, "utf8");
    writeFileSync(outputPath, `${original}misleading success\n`, "utf8");

    // When
    const result = runVerifier([
      "--mode", "compliance", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    writeFileSync(outputPath, original, "utf8");

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("command output digest");
  }, 30_000);

  it("maps every changed path to the five approved outcomes and rejects forbidden paths", () => {
    // Given
    const passing = runVerifier([
      "--mode", "scope", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    const manifestPath = join(fixture.attemptDir, "task-21-operational-fomo-upgrade.manifest.json");
    const integrationPath = join(fixture.attemptDir, "task-21-integration.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    const originalIntegration = readFileSync(integrationPath, "utf8");
    const manifest = JSON.parse(originalManifest) as { changedPaths: string[] };
    manifest.changedPaths.push("vendor/persistent-discord-gateway.ts");
    writeJson(manifestPath, manifest);
    const integration = JSON.parse(originalIntegration) as { manifestSha256: string };
    integration.manifestSha256 = sha256File(manifestPath);
    writeJson(integrationPath, integration);

    // When
    const failing = runVerifier([
      "--mode", "scope", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    writeFileSync(manifestPath, originalManifest, "utf8");
    writeFileSync(integrationPath, originalIntegration, "utf8");

    // Then
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain("outcomes=5/5");
    expect(passing.stdout).toContain("forbiddenPaths=0");
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("forbidden path");
  }, 60_000);

  it("rejects a final commit path that has no immutable task manifest", () => {
    // Given
    writeFileSync(join(fixture.workspace, "unrecorded.txt"), "unrecorded\n", "utf8");
    git(fixture.workspace, ["add", "unrecorded.txt"]);
    git(fixture.workspace, ["commit", "--quiet", "-m", "unrecorded"]);

    // When
    const result = runVerifier([
      "--mode", "scope", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    git(fixture.workspace, ["reset", "--hard", "HEAD^"]);

    // Then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("final diff contains unrecorded paths: unrecorded.txt");
  });

  it("detects generated cleanup leakage directly from the workspace", () => {
    // Given
    const passing = runVerifier([
      "--mode", "cleanup", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    mkdirSync(join(fixture.workspace, ".next"));

    // When
    const failing = runVerifier([
      "--mode", "cleanup", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    rmSync(join(fixture.workspace, ".next"), { force: true, recursive: true });

    // Then
    expect(passing.status, passing.stderr).toBe(0);
    expect(passing.stdout).toContain("cleanupLeaks=0");
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(".next");
  });

  it("binds every mode to immutable attempt identity and rejects malformed CLI input", () => {
    // Given
    const originalPlan = readFileSync(fixture.planPath, "utf8");
    writeFileSync(fixture.planPath, `${originalPlan}\n`, "utf8");

    // When
    const drift = runVerifier([
      "--mode", "scope", "--attempt-dir", fixture.attemptDir, "--workspace", fixture.workspace
    ]);
    writeFileSync(fixture.planPath, originalPlan, "utf8");
    const malformed = runVerifier(["--mode", "unknown", "--attempt-dir", fixture.attemptDir]);

    // Then
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain("attempt identity");
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("invalid arguments");
  });
});

function createEvidenceFixture(): EvidenceFixture {
  const root = mkdtempSync(join(tmpdir(), "operational-evidence-verifier-"));
  const workspace = join(root, "workspace");
  const attemptDir = join(root, "attempt");
  mkdirSync(workspace);
  mkdirSync(attemptDir);
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["config", "user.email", "evidence@example.test"]);
  git(workspace, ["config", "user.name", "Evidence Fixture"]);
  writeFileSync(join(workspace, "README.md"), "fixture\n", "utf8");
  git(workspace, ["add", "README.md"]);
  git(workspace, ["commit", "--quiet", "-m", "base"]);
  const attemptBaseSha = git(workspace, ["rev-parse", "HEAD"]);
  const attemptBaseTreeSha = git(workspace, ["rev-parse", "HEAD^{tree}"]);
  const planPath = join(root, "operational-fomo-upgrade.md");
  writeFileSync(planPath, planFixture(), "utf8");
  const reviewPath = join(root, "approved-review.md");
  writeFileSync(reviewPath, reviewFixture(attemptBaseSha, attemptBaseTreeSha, sha256File(planPath)), "utf8");
  const descriptorPath = join(root, "descriptor.py");
  writeFileSync(descriptorPath, "# immutable fixture descriptor\n", "utf8");
  const attempt = {
    schemaVersion: 1,
    slug: "operational-fomo-upgrade",
    attemptBaseSha,
    attemptBaseTreeSha,
    todo1CommitSha: "0".repeat(40),
    sourceWorkspaceRoot: workspace,
    boundPlanPath: planPath,
    planDescriptorReceipt: descriptorReceipt(root, planPath),
    descriptorScript: fileIdentity(descriptorPath),
    reviewReceipt: {
      descriptor: descriptorReceipt(root, reviewPath),
      roundId: "round-fixture",
      status: "approved",
      roundStatus: "approved",
      planPath: ".omo/plans/operational-fomo-upgrade.md",
      planSha256: sha256File(planPath),
      momusLaunchId: "momus-launch",
      momusSessionId: "momus-session",
      independentLaunchId: "independent-launch",
      independentSessionId: "independent-session",
      momusReviewedHeadSha: attemptBaseSha,
      momusReviewedTreeSha: attemptBaseTreeSha,
      momusReviewedClean: true,
      independentReviewedHeadSha: attemptBaseSha,
      independentReviewedTreeSha: attemptBaseTreeSha,
      independentReviewedClean: true,
      executionBaseSha: attemptBaseSha,
      executionBaseTreeSha: attemptBaseTreeSha
    },
    createdAt: "2026-08-18T00:00:00.000Z"
  };
  writeJson(join(attemptDir, "attempt.json"), attempt);

  const commits = new Map<number, string>();
  let taskStartSha = attemptBaseSha;
  for (let todo = 1; todo <= 21; todo += 1) {
    const changedPath = `task-${todo}.txt`;
    writeFileSync(join(workspace, changedPath), `todo ${todo}\n`, "utf8");
    git(workspace, ["add", changedPath]);
    git(workspace, ["commit", "--quiet", "-m", `todo ${todo}`]);
    const commitSha = git(workspace, ["rev-parse", "HEAD"]);
    const testedTreeSha = git(workspace, ["rev-parse", "HEAD^{tree}"]);
    commits.set(todo, commitSha);
    if (todo === 1) attempt.todo1CommitSha = commitSha;
    const baselineTasks = [...commits.entries()]
      .filter(([baselineTodo]) => baselineTodo < todo)
      .map(([baselineTodo, baselineCommit]) => ({ todo: baselineTodo, commitSha: baselineCommit }));
    const startMode = todo === 1 ? "retrospective_bootstrap" : "pre_edit";
    writeJson(join(attemptDir, `task-${todo}-start.json`), {
      schemaVersion: 1, todo, startMode, taskStartSha, baselineTasks,
      commitSha: todo === 1 ? commitSha : null,
      tree: todo === 1 ? testedTreeSha : git(workspace, ["rev-parse", `${taskStartSha}^{tree}`])
    });
    const outputPath = join(attemptDir, `task-${todo}-command-1.log`);
    writeFileSync(outputPath, `PASS todo ${todo}\n`, "utf8");
    const evidencePath = join(attemptDir, `task-${todo}-operational-fomo-upgrade.txt`);
    writeFileSync(evidencePath, `structural evidence ${todo}\n`, "utf8");
    const manifestPath = join(attemptDir, `task-${todo}-operational-fomo-upgrade.manifest.json`);
    writeJson(manifestPath, {
      schemaVersion: 1,
      planSha256: sha256File(planPath),
      attemptBaseSha,
      todo,
      startMode,
      taskStartSha,
      baselineTasks,
      commitSha,
      testedTreeSha,
      status: "passed",
      commands: [{
        workingDirectory: workspace,
        argv: ["node", "fixture-command.mjs"],
        startedAt: "2026-08-18T00:00:00.000Z",
        finishedAt: "2026-08-18T00:00:01.000Z",
        exitCode: 0,
        timedOut: false,
        commitSha,
        testedTreeSha,
        cleanBefore: true,
        cleanAfter: true,
        outputPath,
        outputSha256: sha256File(outputPath)
      }],
      evidence: [{ path: evidencePath, kind: "text", sha256: sha256File(evidencePath) }],
      changedPaths: [changedPath]
    });
    writeJson(join(attemptDir, `task-${todo}-integration.json`), {
      schemaVersion: 1,
      todo,
      mode: todo === 1 ? "serial_bootstrap" : "no_ff_merge",
      taskCommitSha: commitSha,
      integrationCommitSha: commitSha,
      integratedTreeSha: testedTreeSha,
      manifestSha256: sha256File(manifestPath)
    });
    taskStartSha = commitSha;
  }
  writeJson(join(attemptDir, "attempt.json"), attempt);
  expect(sha256File(planPath)).toMatch(sha256Pattern);
  return { attemptDir, planPath, root, workspace };
}

function indexesInOrder(text: string, needles: readonly string[]): boolean {
  let offset = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle, offset + 1);
    if (index <= offset) return false;
    offset = index;
  }
  return true;
}

function planFixture(): string {
  const dependencies = Array.from({ length: 21 }, (_, index) => {
    const todo = index + 1;
    return `| ${todo} | ${todo === 1 ? "none" : Array.from({ length: todo - 1 }, (_value, dependency) => dependency + 1).join(", ")} | - | - |`;
  }).join("\n");
  const writeSets = Array.from({ length: 21 }, (_, index) => `| ${index + 1} | \`task-${index + 1}.txt\` |`).join("\n");
  return `# operational-fomo-upgrade - Work Plan
## Scope
### Must have
- student certainty
- durable Discord lifecycle
- operations command center
- scalable admin operations
- production readiness and roll-forward proof
### Must NOT have
- persistent gateway vendor scheduler
### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
${dependencies}
### Task-owned write sets
| Todo | Declared write set for this task |
| --- | --- |
${writeSets}
## Todos
`;
}

function reviewFixture(baseSha: string, treeSha: string, planSha256: string): string {
  return `review_round_id: round-fixture
status: approved
round_status: approved
plan_path: .omo/plans/operational-fomo-upgrade.md
plan_sha256: ${planSha256}
  launch_id: momus-launch
  session: momus-session
  launch_id: independent-launch
  session: independent-session
momusReviewedHeadSha: ${baseSha}
momusReviewedTreeSha: ${treeSha}
momusReviewedClean: true
independentReviewedHeadSha: ${baseSha}
independentReviewedTreeSha: ${treeSha}
independentReviewedClean: true
executionBaseSha: ${baseSha}
executionBaseTreeSha: ${treeSha}
`;
}

function descriptorReceipt(root: string, targetPath: string) {
  const metadata = statSync(targetPath, { bigint: true });
  return {
    canonicalRoot: realpathSync(root),
    ancestors: [],
    target: {
      path: targetPath,
      regularFile: true,
      volume: Number(metadata.dev),
      fileIndex: Number(metadata.ino),
      sha256: sha256File(targetPath)
    }
  };
}

function fileIdentity(path: string) {
  const metadata = statSync(path, { bigint: true });
  return {
    path,
    sha256: sha256File(path),
    volume: metadata.dev.toString(),
    fileIndex: metadata.ino.toString()
  };
}

function runVerifier(args: readonly string[]) {
  return spawnSync(process.execPath, [verifier, ...args], {
    cwd: fixture?.workspace ?? process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
