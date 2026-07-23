import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const validator = join(root, "scripts", "verify-readiness-receipts.mjs");
const deploymentSha = "a".repeat(40);
const migrationDigest = "b".repeat(64);
const now = "2026-07-24T00:00:00.000Z";
const temporaryDirectories: string[] = [];

describe("readiness receipt validator", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("accepts a current receipt bound to the expected environment and source", () => {
    const result = runValidator(writeFixture());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Readiness receipts verified: 1 PASS");
  });

  it("rejects an expired receipt", () => {
    const result = runValidator(writeFixture((receipt) => {
      receipt.expiresAt = "2026-07-23T23:59:59.000Z";
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expired");
  });

  it("rejects a deployment SHA mismatch", () => {
    const result = runValidator(writeFixture((receipt) => {
      receipt.deploymentSha = "c".repeat(40);
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deployment SHA");
  });

  it("rejects an environment mismatch", () => {
    const result = runValidator(writeFixture((receipt) => {
      receipt.environment = "production";
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("environment");
  });

  it("rejects a missing artifact digest", () => {
    const result = runValidator(writeFixture((receipt) => {
      delete receipt.artifactSha256;
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("artifactSha256");
  });

  it("rejects secret-bearing receipt fields without echoing their values", () => {
    const secretValue = "must-not-appear-in-output";
    const result = runValidator(writeFixture((receipt) => {
      receipt.apiKey = secretValue;
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sensitive field");
    expect(result.stderr).not.toContain(secretValue);
    expect(result.stdout).not.toContain(secretValue);
  });

  it("rejects a BLOCKED receipt", () => {
    const result = runValidator(writeFixture((receipt) => {
      receipt.status = "BLOCKED";
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BLOCKED");
  });

  it("rejects a receipt changed after manifest generation", () => {
    const manifestPath = writeFixture();
    appendFileSync(join(dirname(manifestPath), "receipts", "monitoring.json"), "\n", "utf8");

    const result = runValidator(manifestPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed after manifest");
  });

  it("rejects duplicate receipt IDs", () => {
    const result = runValidator(writeFixture(undefined, (manifest) => {
      const receipts = manifest.receipts;
      if (Array.isArray(receipts)) {
        receipts.push(receipts[0]);
      }
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate receipt id");
  });

  it("rejects artifact paths outside the evidence root", () => {
    const result = runValidator(writeFixture((receipt) => {
      receipt.artifactPath = "../outside.txt";
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("escapes the evidence root");
  });
});

function runValidator(manifestPath: string) {
  return spawnSync(process.execPath, [
    validator,
    "--manifest",
    manifestPath,
    "--deployment-sha",
    deploymentSha,
    "--environment",
    "staging",
    "--migration-digest",
    migrationDigest,
    "--now",
    now
  ], {
    cwd: root,
    encoding: "utf8"
  });
}

function writeFixture(
  mutateReceipt?: (receipt: Record<string, unknown>) => void,
  mutateManifest?: (manifest: Record<string, unknown>) => void
): string {
  const directory = mkdtempSync(join(tmpdir(), "readiness-receipts-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "artifacts"));
  mkdirSync(join(directory, "receipts"));

  const artifactPath = join(directory, "artifacts", "monitoring.txt");
  writeFileSync(artifactPath, "alert delivery verified\n", "utf8");
  const receipt: Record<string, unknown> = {
    artifactPath: "artifacts/monitoring.txt",
    artifactSha256: sha256(artifactPath),
    capturedAt: "2026-07-23T12:00:00.000Z",
    deploymentSha,
    environment: "staging",
    evidenceUrl: "https://monitoring.example.test/evidence/alert-test",
    expiresAt: "2026-08-23T12:00:00.000Z",
    gate: "P0-2",
    id: "monitoring-alert-delivery",
    invalidationCondition: "Deployment, project, threshold, owner, or alert route changes.",
    migrationDigest,
    operator: "information-room-owner",
    projectId: "info-room-staging",
    provider: "example-monitoring",
    schemaVersion: 1,
    status: "PASS"
  };
  mutateReceipt?.(receipt);

  const receiptPath = join(directory, "receipts", "monitoring.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  const manifestPath = join(directory, "manifest.json");
  const manifest: Record<string, unknown> = {
    generatedAt: "2026-07-23T12:05:00.000Z",
    receipts: [{
      id: "monitoring-alert-delivery",
      path: "receipts/monitoring.json",
      sha256: sha256(receiptPath)
    }],
    runId: "20260723T120500Z-readiness-fixture",
    schemaVersion: 1
  };
  mutateManifest?.(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
