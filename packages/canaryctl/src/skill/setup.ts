import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillSetupTarget = "codex" | "claude-code";

export interface SkillInstallTarget {
  target: SkillSetupTarget;
  destinationPath: string;
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function getCanonicalCanarySkillPath(): string {
  return fileURLToPath(new URL("../../../../skills/canary", import.meta.url));
}

export function resolveSkillInstallTargets(targets: SkillSetupTarget[]): SkillInstallTarget[] {
  const installs: SkillInstallTarget[] = [];
  const homeDir = os.homedir();

  if (targets.includes("codex")) {
    const codexHome = process.env.CODEX_HOME ?? path.join(homeDir, ".codex");
    installs.push({
      target: "codex",
      destinationPath: path.join(codexHome, "skills", "canary")
    });
  }

  if (targets.includes("claude-code")) {
    const claudeHome = process.env.CLAUDE_HOME ?? path.join(homeDir, ".claude");
    installs.push({
      target: "claude-code",
      destinationPath: path.join(claudeHome, "skills", "canary")
    });
  }

  return installs;
}

export async function replaceSkillSymlink(sourcePath: string, destinationPath: string): Promise<"linked" | "unchanged"> {
  const existing = await fs.lstat(destinationPath).catch((error) => {
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  });

  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-symlink path: ${destinationPath}`);
    }

    const currentTarget = await fs.readlink(destinationPath);
    const resolvedCurrentTarget = path.resolve(path.dirname(destinationPath), currentTarget);
    if (resolvedCurrentTarget === sourcePath) {
      return "unchanged";
    }

    await fs.unlink(destinationPath);
  }

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  const sourceStats = await fs.stat(sourcePath);
  const symlinkType =
    process.platform === "win32" ? (sourceStats.isDirectory() ? "junction" : "file") : undefined;
  await fs.symlink(sourcePath, destinationPath, symlinkType);
  return "linked";
}
