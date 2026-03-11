import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function canonicalizePath(inputPath: string): string {
  const resolvedPath = path.resolve(inputPath);

  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function resolveProjectRootOverride(): string | null {
  const override = process.env.CANARY_PROJECT_ROOT?.trim();
  return override ? canonicalizePath(override) : null;
}

function resolveGitRootFromCommand(cwd: string): string | null {
  try {
    const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    return stdout ? canonicalizePath(stdout) : null;
  } catch {
    return null;
  }
}

function resolveGitRootFromFilesystem(cwd: string): string | null {
  let current = cwd;

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

function slugifyProjectName(projectRoot: string): string {
  const basename = path.basename(projectRoot).trim();
  const slug = basename
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  return slug || "project";
}

export function resolveProjectRoot(cwd: string): string {
  const override = resolveProjectRootOverride();
  if (override) {
    return override;
  }

  const canonicalCwd = canonicalizePath(cwd);

  return (
    resolveGitRootFromCommand(canonicalCwd) ??
    resolveGitRootFromFilesystem(canonicalCwd) ??
    canonicalCwd
  );
}

export function getCanaryHomeDir(): string {
  const override = process.env.CANARY_HOME?.trim();
  return override ? canonicalizePath(override) : path.join(os.homedir(), ".canary");
}

export function getProjectStorageKey(projectRoot: string): string {
  const canonicalProjectRoot = resolveProjectRoot(projectRoot);
  const digest = createHash("sha256").update(canonicalProjectRoot).digest("hex").slice(0, 16);
  return `${slugifyProjectName(canonicalProjectRoot)}-${digest}`;
}

export function getProjectStateDir(projectRoot: string): string {
  return path.join(getCanaryHomeDir(), "projects", getProjectStorageKey(projectRoot));
}

export function getProjectDbFile(projectRoot: string): string {
  return path.join(getProjectStateDir(projectRoot), "canary.db");
}
