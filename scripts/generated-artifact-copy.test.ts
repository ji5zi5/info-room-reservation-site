import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyGeneratedArtifact } from "./generated-artifact-copy.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("generated artifact snapshots", () => {
  it("copies a directory link without requiring Windows symbolic-link privileges", () => {
    // Given: Next development output uses directory junctions for generated package references.
    const root = mkdtempSync(join(tmpdir(), "generated-artifact-copy-"));
    roots.push(root);
    const target = join(root, "target");
    const source = join(root, "source-link");
    const destination = join(root, "snapshot-link");
    mkdirSync(target);
    writeFileSync(join(target, "client.txt"), "prisma-client");
    symlinkSync(target, source, process.platform === "win32" ? "junction" : "dir");

    // When
    copyGeneratedArtifact(source, destination);

    // Then
    expect(realpathSync(destination)).toBe(realpathSync(target));
  });
});
