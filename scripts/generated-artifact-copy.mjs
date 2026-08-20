import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync
} from "node:fs";
import { dirname, join } from "node:path";

export function copyGeneratedArtifact(source, destination) {
  const metadata = lstatSync(source);
  if (metadata.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyGeneratedArtifact(join(source, entry), join(destination, entry));
    }
    return;
  }
  mkdirSync(dirname(destination), { recursive: true });
  if (metadata.isFile()) {
    copyFileSync(source, destination);
    return;
  }
  if (metadata.isSymbolicLink()) {
    copyLink(source, destination);
    return;
  }
  throw new UnsupportedGeneratedArtifactError(source);
}

function copyLink(source, destination) {
  const directory = statSync(source).isDirectory();
  if (process.platform === "win32") {
    if (directory) {
      symlinkSync(realpathSync(source), destination, "junction");
    } else {
      copyFileSync(realpathSync(source), destination);
    }
    return;
  }
  symlinkSync(readlinkSync(source), destination, directory ? "dir" : "file");
}

class UnsupportedGeneratedArtifactError extends Error {
  constructor(path) {
    super(`Unsupported generated artifact type: ${path}`);
    this.name = "UnsupportedGeneratedArtifactError";
  }
}
