import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addThreadMessage,
  applyMigrations,
  getProjectStateDir,
  listThreads,
  openConnection,
  reconcileArtifactsForFileChange,
  upsertFileBrief
} from "@canaryctl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBriefList } from "./brief-list.js";
import { runTodoList } from "./todo-list.js";
import { runThreadList } from "./thread-list.js";
import { runThreadOpen } from "./thread-open.js";
import { runThreadSetStatus } from "./thread-set-status.js";

const tempDirs: string[] = [];

function createProjectRoot(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canaryctl-threads-"));
  tempDirs.push(projectRoot);
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src/example.ts"), "export const value = 1;\n");
  return projectRoot;
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

function writeProjectFile(projectRoot: string, filePath: string, content: string): void {
  const absolutePath = path.join(projectRoot, filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const tempDir = tempDirs.pop();
    if (tempDir) {
      fs.rmSync(getProjectStateDir(tempDir), { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

describe("thread commands", () => {
  it("lists pending threads after a user-authored reply", async () => {
    const projectRoot = createProjectRoot();

    const openCapture = captureStdout();
    await runThreadOpen({
      cwd: projectRoot,
      file: "src/example.ts",
      startLine: 1,
      endLine: 2,
      type: "risk",
      title: "Need user input",
      body: "Can you confirm this?",
      json: false
    });
    openCapture.restore();

    const connection = openConnection(projectRoot);
    applyMigrations(connection);

    try {
      const [thread] = await listThreads(connection, { status: "all", limit: 1 });
      expect(thread).toBeDefined();

      const reply = await addThreadMessage(connection, {
        threadId: thread!.id,
        body: "Please keep it.",
        author: "user",
        source: "review-ui"
      });
      expect(reply.author).toBe("user");
      expect(reply.threadId).toBe(thread!.id);

      const listCapture = captureStdout();
      await runThreadList({
        cwd: projectRoot,
        pendingFor: "agent",
        status: "all",
        json: true
      });
      listCapture.restore();

      const summaries = JSON.parse(listCapture.output()) as Array<{
        id: string;
        pendingFor: string | null;
        lastAuthor: string | null;
        filePath: string | null;
      }>;

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.id).toBe(thread!.id);
      expect(summaries[0]?.pendingFor).toBe("agent");
      expect(summaries[0]?.lastAuthor).toBe("user");
      expect(summaries[0]?.filePath).toBe("src/example.ts");
    } finally {
      connection.close();
    }
  });

  it("resolves and reopens threads through the CLI command layer", async () => {
    const projectRoot = createProjectRoot();

    const openCapture = captureStdout();
    await runThreadOpen({
      cwd: projectRoot,
      file: "src/example.ts",
      startLine: 1,
      endLine: 2,
      type: "risk",
      title: "Close this out",
      body: "This thread should be resolved from the UI or CLI.",
      json: false
    });
    openCapture.restore();

    const connection = openConnection(projectRoot);
    applyMigrations(connection);

    try {
      const [thread] = await listThreads(connection, { status: "all", limit: 1 });
      expect(thread).toBeDefined();

      const resolveCapture = captureStdout();
      await runThreadSetStatus({
        cwd: projectRoot,
        threadId: thread!.id,
        status: "resolved",
        json: true
      });
      resolveCapture.restore();

      const resolved = JSON.parse(resolveCapture.output()) as { status: string };
      expect(resolved.status).toBe("resolved");

      const reopenCapture = captureStdout();
      await runThreadSetStatus({
        cwd: projectRoot,
        threadId: thread!.id,
        status: "open",
        json: true
      });
      reopenCapture.restore();

      const reopened = JSON.parse(reopenCapture.output()) as { status: string };
      expect(reopened.status).toBe("open");
    } finally {
      connection.close();
    }
  });

  it("filters thread listings by freshness", async () => {
    const projectRoot = createProjectRoot();
    const filePath = "src/example.ts";
    const oldContent = "export const value = 1;\nexport const flag = true;\n";
    const newContent = "export const VALUE = 1;\nexport const flag = true;\n";
    const patch = [
      "Index: src/example.ts",
      "===================================================================",
      "--- src/example.ts",
      "+++ src/example.ts",
      "@@ -1,2 +1,2 @@",
      "-export const value = 1;",
      "+export const VALUE = 1;",
      " export const flag = true;",
      ""
    ].join("\n");

    writeProjectFile(projectRoot, filePath, oldContent);

    const openCapture = captureStdout();
    await runThreadOpen({
      cwd: projectRoot,
      file: filePath,
      startLine: 1,
      endLine: 2,
      type: "risk",
      title: "Will go outdated",
      body: "Track this anchor.",
      json: false
    });
    openCapture.restore();

    const connection = openConnection(projectRoot);
    applyMigrations(connection);

    try {
      writeProjectFile(projectRoot, filePath, newContent);
      await reconcileArtifactsForFileChange(connection, {
        filePath,
        oldContent,
        newContent,
        patch
      });

      const listCapture = captureStdout();
      await runThreadList({
        cwd: projectRoot,
        freshness: "outdated",
        status: "all",
        json: true
      });
      listCapture.restore();

      const summaries = JSON.parse(listCapture.output()) as Array<{ freshness: string }>;
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.freshness).toBe("outdated");
    } finally {
      connection.close();
    }
  });

  it("lists outdated briefs and unified todos from the CLI layer", async () => {
    const projectRoot = createProjectRoot();
    const filePath = "src/example.ts";
    const oldContent = "export const value = 1;\nexport const flag = true;\n";
    const newContent = "export const VALUE = 1;\nexport const flag = true;\n";
    const patch = [
      "Index: src/example.ts",
      "===================================================================",
      "--- src/example.ts",
      "+++ src/example.ts",
      "@@ -1,2 +1,2 @@",
      "-export const value = 1;",
      "+export const VALUE = 1;",
      " export const flag = true;",
      ""
    ].join("\n");

    writeProjectFile(projectRoot, filePath, oldContent);

    const openCapture = captureStdout();
    await runThreadOpen({
      cwd: projectRoot,
      file: filePath,
      startLine: 1,
      endLine: 2,
      type: "risk",
      title: "Needs cleanup",
      body: "Track this anchor.",
      json: false
    });
    openCapture.restore();

    const connection = openConnection(projectRoot);
    applyMigrations(connection);

    try {
      const [thread] = await listThreads(connection, { status: "all", limit: 1 });
      expect(thread).toBeDefined();

      await upsertFileBrief(connection, {
        filePath,
        summary: "Owns the example export."
      });

      writeProjectFile(projectRoot, filePath, newContent);
      await reconcileArtifactsForFileChange(connection, {
        filePath,
        oldContent,
        newContent,
        patch
      });
      await addThreadMessage(connection, {
        threadId: thread!.id,
        body: "Please revisit this.",
        author: "user"
      });

      const briefCapture = captureStdout();
      await runBriefList({
        cwd: projectRoot,
        freshness: "outdated",
        json: true
      });
      briefCapture.restore();

      const todoCapture = captureStdout();
      await runTodoList({
        cwd: projectRoot,
        json: true
      });
      todoCapture.restore();

      const briefs = JSON.parse(briefCapture.output()) as Array<{ freshness: string }>;
      const todos = JSON.parse(todoCapture.output()) as Array<{ kind: string }>;

      expect(briefs).toHaveLength(1);
      expect(briefs[0]?.freshness).toBe("outdated");
      expect(todos.map((item) => item.kind)).toContain("thread_anchor_outdated");
      expect(todos.map((item) => item.kind)).toContain("brief_outdated");
    } finally {
      connection.close();
    }
  });
});
