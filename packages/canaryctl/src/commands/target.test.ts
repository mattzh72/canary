import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFilePath } from "./target.js";

describe("normalizeFilePath", () => {
  const projectRoot = path.join(path.sep, "workspace", "project");

  it("normalizes relative paths within the project root", () => {
    expect(normalizeFilePath(projectRoot, "./src/../src/app.ts")).toBe("src/app.ts");
  });

  it("normalizes absolute paths within the project root", () => {
    expect(normalizeFilePath(projectRoot, path.join(projectRoot, "src", "app.ts"))).toBe(
      "src/app.ts"
    );
  });

  it("rejects paths outside the project root", () => {
    expect(() => normalizeFilePath(projectRoot, "../other/app.ts")).toThrow(
      "File path must stay within the project root"
    );
  });
});
