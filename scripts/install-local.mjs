#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const binDir =
  process.env.CANARY_BIN_DIR ??
  (process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local", "canary", "bin")
    : path.join(os.homedir(), ".local", "bin"));
const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const codexSkillsDir = path.join(codexHome, "skills");

const installs = [
  {
    label: "canary",
    sourcePath: path.join(repoRoot, "packages", "canary", "dist", "cli", "index.js"),
    targetPath: path.join(binDir, "canary")
  },
  {
    label: "canaryctl",
    sourcePath: path.join(repoRoot, "packages", "canaryctl", "dist", "cli", "index.js"),
    targetPath: path.join(binDir, "canaryctl")
  },
  {
    label: "canary-skill",
    sourcePath: path.join(repoRoot, "skills", "canary"),
    targetPath: path.join(codexSkillsDir, "canary")
  }
];

async function pathExists(targetPath) {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }

    throw error;
  }
}

function isNotFound(error) {
  return Boolean(error) && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function pathOnEnv(targetPath) {
  const entries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => path.resolve(entry));

  return entries.includes(path.resolve(targetPath));
}

async function ensureBuilt(sourcePath) {
  if (!(await pathExists(sourcePath))) {
    throw new Error(`Missing build artifact: ${sourcePath}`);
  }
}

async function replaceSymlink(sourcePath, targetPath) {
  const existing = await fs.lstat(targetPath).catch((error) => {
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  });

  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink path: ${targetPath}`);
    }

    const currentTarget = await fs.readlink(targetPath);
    const resolvedCurrentTarget = path.resolve(path.dirname(targetPath), currentTarget);
    if (resolvedCurrentTarget === sourcePath) {
      return "unchanged";
    }

    await fs.unlink(targetPath);
  }

  const sourceStats = await fs.stat(sourcePath);
  const symlinkType =
    process.platform === "win32" ? (sourceStats.isDirectory() ? "junction" : "file") : undefined;

  await fs.symlink(sourcePath, targetPath, symlinkType);
  return "linked";
}

async function main() {
  for (const install of installs) {
    await ensureBuilt(install.sourcePath);
    await fs.mkdir(path.dirname(install.targetPath), { recursive: true });
  }

  for (const install of installs) {
    const status = await replaceSymlink(install.sourcePath, install.targetPath);
    process.stdout.write(`[install] ${status} ${install.targetPath} -> ${install.sourcePath}\n`);
  }

  if (!pathOnEnv(binDir)) {
    process.stdout.write(
      `[install] warning: ${binDir} is not on PATH. Add it before using canary or canaryctl.\n`
    );
  }

  process.stdout.write("[install] restart Codex to pick up the Canary skill.\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
