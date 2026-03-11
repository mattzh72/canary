import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSkillSetup } from "./skill-setup.js";
import { getCanonicalCanarySkillPath } from "../skill/setup.js";

const tempDirs: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalClaudeHome = process.env.CLAUDE_HOME;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });

  return {
    output() {
      return chunks.join("");
    },
    restore() {
      spy.mockRestore();
    }
  };
}

afterEach(() => {
  process.env.CODEX_HOME = originalCodexHome;
  process.env.CLAUDE_HOME = originalClaudeHome;

  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("runSkillSetup", () => {
  it("links the canonical Canary skill for Codex and Claude Code", async () => {
    const codexHome = createTempDir("canaryctl-codex-home-");
    const claudeHome = createTempDir("canaryctl-claude-home-");
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_HOME = claudeHome;
    const capture = captureStdout();

    try {
      await runSkillSetup({
        codex: true,
        claudeCode: true
      });
    } finally {
      capture.restore();
    }

    const canonicalPath = getCanonicalCanarySkillPath();
    const codexSkillPath = path.join(codexHome, "skills", "canary");
    const claudeSkillPath = path.join(claudeHome, "skills", "canary");

    expect(fs.realpathSync(codexSkillPath)).toBe(canonicalPath);
    expect(fs.realpathSync(claudeSkillPath)).toBe(canonicalPath);
    expect(capture.output()).toContain("[skill] linked codex");
    expect(capture.output()).toContain("[skill] linked claude-code");
  });

  it("requires at least one install target", async () => {
    await expect(runSkillSetup({})).rejects.toThrow(
      "Choose at least one target: --codex or --claude-code"
    );
  });
});
