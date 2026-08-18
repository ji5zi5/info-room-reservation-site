#!/usr/bin/env node
// allow: SIZE_OK — receipt schema, provenance, path confinement, and digest checks are one auditable CLI boundary.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const deploymentShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const httpsUrlSchema = z.string().url().refine((value) => value.startsWith("https://"), {
  message: "must use https"
});
const manifestSchema = z.object({
  generatedAt: z.string().min(1),
  receipts: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    sha256: sha256Schema
  }).strict()).min(1),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
  schemaVersion: z.literal(1)
}).strict();
const receiptSchema = z.object({
  artifactPath: z.string().min(1),
  artifactSha256: sha256Schema,
  capturedAt: z.string().min(1),
  deploymentSha: deploymentShaSchema,
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/),
  evidenceUrl: httpsUrlSchema,
  expiresAt: z.string().min(1),
  gate: z.string().regex(/^P[01]-\d+$/),
  id: z.string().min(1),
  invalidationCondition: z.string().min(12),
  migrationDigest: sha256Schema,
  operator: z.string().min(1),
  projectId: z.string().min(1),
  provider: z.string().min(1),
  schemaVersion: z.literal(1),
  status: z.enum(["BLOCKED", "PASS"])
}).strict();
const sensitiveFieldPattern =
  /(?:authorization|bearer|cookie|password|secret|token|webhook|api[_-]?key)/i;

try {
  const options = parseArguments(process.argv.slice(2));
  const now = parseTimestamp(options.now ?? new Date().toISOString(), "--now");
  const manifestPath = realpathSync(resolve(options.manifest));
  const evidenceRoot = realpathSync(dirname(manifestPath));
  const manifest = readJson(manifestPath, manifestSchema, "manifest");
  const generatedAt = parseTimestamp(manifest.generatedAt, "manifest.generatedAt");
  if (generatedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw new Error("manifest.generatedAt is in the future");
  }

  const receiptIds = new Set();
  const receiptPaths = new Set();
  const receiptDigests = new Set();
  const artifactPaths = new Set();
  const artifactDigests = new Set();
  const gates = new Set();

  for (const entry of manifest.receipts) {
    assertUnique(receiptIds, entry.id, `duplicate receipt id: ${entry.id}`);
    const receiptPath = resolveEvidenceFile(evidenceRoot, entry.path, `receipt ${entry.id}`);
    assertUnique(receiptPaths, receiptPath, `reused receipt path: ${entry.path}`);
    assertUnique(receiptDigests, entry.sha256, `reused receipt digest: ${entry.id}`);
    if (receiptPath === manifestPath) {
      throw new Error(`receipt ${entry.id} reuses the manifest path`);
    }
    if (sha256File(receiptPath) !== entry.sha256) {
      throw new Error(`receipt ${entry.id} changed after manifest generation`);
    }

    const receipt = readJson(receiptPath, receiptSchema, `receipt ${entry.id}`);
    if (receipt.id !== entry.id) {
      throw new Error(`receipt id mismatch for ${entry.id}`);
    }
    if (receipt.status !== "PASS") {
      throw new Error(`receipt ${entry.id} is ${receipt.status}`);
    }
    if (receipt.deploymentSha !== options.deploymentSha) {
      throw new Error(`receipt ${entry.id} deployment SHA does not match`);
    }
    if (receipt.environment !== options.environment) {
      throw new Error(`receipt ${entry.id} environment does not match`);
    }
    if (receipt.migrationDigest !== options.migrationDigest) {
      throw new Error(`receipt ${entry.id} migration digest does not match`);
    }
    assertUnique(gates, receipt.gate, `duplicate readiness gate: ${receipt.gate}`);

    const capturedAt = parseTimestamp(receipt.capturedAt, `receipt ${entry.id}.capturedAt`);
    const expiresAt = parseTimestamp(receipt.expiresAt, `receipt ${entry.id}.expiresAt`);
    if (capturedAt.getTime() > now.getTime() + 5 * 60_000) {
      throw new Error(`receipt ${entry.id} was captured in the future`);
    }
    if (capturedAt.getTime() > generatedAt.getTime()) {
      throw new Error(`receipt ${entry.id} was captured after manifest generation`);
    }
    if (expiresAt.getTime() <= capturedAt.getTime()) {
      throw new Error(`receipt ${entry.id} expiry is not after capture`);
    }
    if (expiresAt.getTime() - capturedAt.getTime() > 31 * 24 * 60 * 60_000) {
      throw new Error(`receipt ${entry.id} validity exceeds 31 days`);
    }
    if (expiresAt.getTime() <= now.getTime()) {
      throw new Error(`receipt ${entry.id} is expired`);
    }

    const artifactPath = resolveEvidenceFile(
      evidenceRoot,
      receipt.artifactPath,
      `receipt ${entry.id} artifact`
    );
    assertUnique(artifactPaths, artifactPath, `reused artifact path: ${receipt.artifactPath}`);
    if (artifactPath === receiptPath || artifactPath === manifestPath) {
      throw new Error(`receipt ${entry.id} artifact reuses a metadata path`);
    }
    assertUnique(artifactDigests, receipt.artifactSha256, `reused artifact digest: ${entry.id}`);
    if (sha256File(artifactPath) !== receipt.artifactSha256) {
      throw new Error(`receipt ${entry.id} artifact digest does not match`);
    }
    if (statSync(artifactPath).size === 0) {
      throw new Error(`receipt ${entry.id} artifact is empty`);
    }
    const evidenceUrl = new URL(receipt.evidenceUrl);
    if (evidenceUrl.username || evidenceUrl.password || evidenceUrl.search || evidenceUrl.hash) {
      throw new Error(`receipt ${entry.id} evidence URL contains credentials, query, or fragment data`);
    }
  }

  console.log(`Readiness receipts verified: ${manifest.receipts.length} PASS receipt(s).`);
} catch (error) {
  console.error("Readiness receipt verification failed:");
  console.error(`- ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}

function parseArguments(args) {
  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }
  if (args.length % 2 !== 0) {
    throw new Error("every option must have a value");
  }

  const values = new Map();
  const allowed = new Set([
    "--deployment-sha",
    "--environment",
    "--manifest",
    "--migration-digest",
    "--now"
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || !value) {
      throw new Error(`invalid option: ${key ?? "(missing)"}`);
    }
    values.set(key, value);
  }

  const manifest = requireOption(values, "--manifest");
  const environment = requireOption(values, "--environment");
  const deploymentSha = requireOption(values, "--deployment-sha");
  const migrationDigest = requireOption(values, "--migration-digest");
  if (!deploymentShaSchema.safeParse(deploymentSha).success) {
    throw new Error("--deployment-sha must be a full lowercase Git SHA");
  }
  if (!sha256Schema.safeParse(migrationDigest).success) {
    throw new Error("--migration-digest must be a lowercase SHA-256");
  }
  return {
    deploymentSha,
    environment,
    manifest,
    migrationDigest,
    now: values.get("--now")
  };
}

function requireOption(values, key) {
  const value = values.get(key);
  if (!value) {
    throw new Error(`missing required option: ${key}`);
  }
  return value;
}

function readJson(path, schema, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (hasSensitiveField(value)) {
    throw new Error(`${label} contains a forbidden sensitive field`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${label} is invalid: ${issues}`);
  }
  return result.data;
}

function hasSensitiveField(value) {
  if (Array.isArray(value)) {
    return value.some(hasSensitiveField);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) => sensitiveFieldPattern.test(key) || hasSensitiveField(nested)
  );
}

function resolveEvidenceFile(root, path, label) {
  if (isAbsolute(path)) {
    throw new Error(`${label} path must be relative`);
  }
  if (path.split("/").includes("..")) {
    throw new Error(`${label} path escapes the evidence root`);
  }
  if (path.includes("\\") || path.split("/").some((segment) => segment === "" || segment === ".")) {
    throw new Error(`${label} path must be canonical and use forward slashes`);
  }
  const resolved = resolve(root, path);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${label} path escapes the evidence root`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`${label} file is missing`);
  }
  if (lstatSync(resolved).isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  const realPath = realpathSync(resolved);
  const realRelativePath = relative(root, realPath);
  if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
    throw new Error(`${label} resolves outside the evidence root`);
  }
  return realPath;
}

function assertUnique(values, value, message) {
  if (values.has(value)) {
    throw new Error(message);
  }
  values.add(value);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseTimestamp(value, label) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error(`${label} must be an ISO UTC timestamp`);
  }
  return timestamp;
}

function printUsage() {
  console.log(
    "Usage: node scripts/verify-readiness-receipts.mjs " +
    "--manifest <path> --deployment-sha <40-hex> --environment <name> " +
    "--migration-digest <64-hex> [--now <ISO-UTC>]"
  );
}
