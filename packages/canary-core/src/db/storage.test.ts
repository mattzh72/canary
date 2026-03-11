import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openConnection } from "./connection.js";
import { getCanaryHomeDir, getProjectStateDir, resolveProjectRoot } from "./storage.js";

const tempDirs: string[] = [];
const projectRoots: string[] = [];

function createTempDir(prefix: string): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempDir);
  return tempDir;
}

function trackProjectRoot(projectRoot: string): string {
  projectRoots.push(resolveProjectRoot(projectRoot));
  return projectRoot;
}

afterEach(() => {
  delete process.env.CANARY_PROJECT_ROOT;

  while (projectRoots.length > 0) {
    const projectRoot = projectRoots.pop();
    if (projectRoot) {
      fs.rmSync(getProjectStateDir(projectRoot), { recursive: true, force: true });
    }
  }

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("storage", () => {
  it("resolves nested git directories to the repo root", () => {
    const projectRoot = trackProjectRoot(createTempDir("canary-core-storage-root-"));
    const nestedDir = path.join(projectRoot, "packages", "canary");
    fs.mkdirSync(nestedDir, { recursive: true });
    execFileSync("git", ["init"], {
      cwd: projectRoot,
      stdio: "ignore"
    });

    expect(resolveProjectRoot(nestedDir)).toBe(resolveProjectRoot(projectRoot));
  });

  it("prefers CANARY_PROJECT_ROOT when it is set", () => {
    const projectRoot = createTempDir("canary-core-storage-override-");
    const nestedDir = path.join(projectRoot, "nested", "demo");
    fs.mkdirSync(nestedDir, { recursive: true });
    process.env.CANARY_PROJECT_ROOT = projectRoot;
    const canonicalProjectRoot = resolveProjectRoot(projectRoot);
    projectRoots.push(canonicalProjectRoot);

    expect(resolveProjectRoot(nestedDir)).toBe(canonicalProjectRoot);
  });

  it("stores each project's sqlite database under the global canary home", () => {
    const projectRoot = trackProjectRoot(createTempDir("canary-core-storage-db-"));
    const canonicalProjectRoot = resolveProjectRoot(projectRoot);
    const connection = openConnection(projectRoot);

    try {
      expect(connection.projectRoot).toBe(canonicalProjectRoot);
      expect(connection.stateDir).toBe(getProjectStateDir(canonicalProjectRoot));
      expect(connection.dbFile).toBe(path.join(getProjectStateDir(canonicalProjectRoot), "canary.db"));
      expect(connection.dbFile.startsWith(getCanaryHomeDir())).toBe(true);
      expect(fs.existsSync(connection.dbFile)).toBe(true);
    } finally {
      connection.close();
    }
  });
});
