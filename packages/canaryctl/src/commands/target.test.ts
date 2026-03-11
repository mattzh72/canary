import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFilePath } from "./target.js";

describe("normalizeFilePath", () => {
  function createProjectRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "canaryctl-target-"));
  }

  it("normalizes relative paths within the project root", () => {
    const projectRoot = createProjectRoot();
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "");
    expect(normalizeFilePath(projectRoot, "./src/../src/app.ts")).toBe("src/app.ts");
  });

  it("normalizes absolute paths within the project root", () => {
    const projectRoot = createProjectRoot();
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "");
    expect(normalizeFilePath(projectRoot, path.join(projectRoot, "src", "app.ts"))).toBe(
      "src/app.ts"
    );
  });

  it("rejects paths outside the project root", () => {
    const projectRoot = createProjectRoot();
    expect(() => normalizeFilePath(projectRoot, "../other/app.ts")).toThrow(
      "File path must stay within the project root"
    );
  });

  it("rejects files that do not exist", () => {
    const projectRoot = createProjectRoot();
    expect(() => normalizeFilePath(projectRoot, "src/missing.ts")).toThrow(
      "Target file does not exist: src/missing.ts (normalized: src/missing.ts)"
    );
  });

  it("rejects directories", () => {
    const projectRoot = createProjectRoot();
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    expect(() => normalizeFilePath(projectRoot, "src")).toThrow(
      "Target path is not a file: src (normalized: src)"
    );
  });
});
