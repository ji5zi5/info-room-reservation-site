import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();
const nextEnvPath = join(cwd, "next-env.d.ts");
const originalNextEnv = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, "utf8") : null;

class CommandFailedError extends Error {
  constructor(command, exitCode) {
    super(`${command} exited with code ${exitCode}`);
    this.exitCode = exitCode;
    this.name = "CommandFailedError";
  }
}

let exitCode = 0;

try {
  runNodeBin(join(cwd, "node_modules", "next", "dist", "bin", "next"), ["typegen"]);
  rmSync(join(cwd, ".next", "dev", "types"), { force: true, recursive: true });
  runNodeBin(join(cwd, "node_modules", "typescript", "bin", "tsc"), ["--noEmit"]);
} catch (error) {
  exitCode = error instanceof CommandFailedError ? error.exitCode : 1;
  if (!(error instanceof CommandFailedError)) {
    console.error(error);
  }
} finally {
  if (originalNextEnv !== null && existsSync(nextEnvPath) && readFileSync(nextEnvPath, "utf8") !== originalNextEnv) {
    writeFileSync(nextEnvPath, originalNextEnv);
  }
}

process.exit(exitCode);

function runNodeBin(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd, stdio: "inherit" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new CommandFailedError(scriptPath, result.status ?? 1);
  }
}
