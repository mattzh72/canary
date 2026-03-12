import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openConnection } from "../db/connection.js";
import { applyMigrations } from "../db/migrate.js";
import { getProjectStateDir } from "../db/storage.js";
import {
  addThreadMessage,
  appendEvent,
  createSession,
  createThread,
  getProjectOverview,
  listFileBriefs,
  listTodos,
  listThreads,
  reconcileArtifactsForFileChange,
  updateThreadStatus,
  upsertFileBrief
} from "./project-repository.js";

const tempDirs: string[] = [];

function createTestConnection() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canary-core-threads-"));
  tempDirs.push(projectRoot);
  const connection = openConnection(projectRoot);
  applyMigrations(connection);
  return connection;
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

describe("listThreads", () => {
  it("keeps threads active and remaps them when a file change can be proven exactly", async () => {
    const connection = createTestConnection();
    const filePath = "src/remap.ts";
    const oldContent = ["a", "b", "c", "d", "e", "f", "g", ""].join("\n");
    const newContent = ["a", "b", "three", "d", "e", "six", "g", ""].join("\n");
    const patch = [
      "Index: src/remap.ts",
      "===================================================================",
      "--- src/remap.ts",
      "+++ src/remap.ts",
      "@@ -1,7 +1,7 @@",
      " a",
      " b",
      "-c",
      "+three",
      " d",
      " e",
      "-f",
      "+six",
      " g",
      ""
    ].join("\n");

    writeProjectFile(connection.projectRoot, filePath, oldContent);

    try {
      const thread = await createThread(connection, {
        filePath,
        startLine: 4,
        endLine: 5,
        lineSide: "new",
        title: "Preserve this anchor",
        body: "These lines should still map exactly.",
        type: "decision"
      });

      writeProjectFile(connection.projectRoot, filePath, newContent);
      await reconcileArtifactsForFileChange(connection, {
        filePath,
        oldContent,
        newContent,
        patch
      });

      const [updated] = await listThreads(connection, {
        status: "all",
        filePath,
        limit: 1
      });

      expect(updated?.id).toBe(thread.id);
      expect(updated?.freshness).toBe("active");
      expect(updated?.startLine).toBe(4);
      expect(updated?.endLine).toBe(5);
    } finally {
      connection.close();
    }
  });

  it("marks threads outdated when an edit touches the anchored span", async () => {
    const connection = createTestConnection();
    const filePath = "src/outdated.ts";
    const oldContent = ["alpha", "beta", "gamma", "delta", ""].join("\n");
    const newContent = ["alpha", "beta", "GAMMA", "delta", ""].join("\n");
    const patch = [
      "Index: src/outdated.ts",
      "===================================================================",
      "--- src/outdated.ts",
      "+++ src/outdated.ts",
      "@@ -1,4 +1,4 @@",
      " alpha",
      " beta",
      "-gamma",
      "+GAMMA",
      " delta",
      ""
    ].join("\n");

    writeProjectFile(connection.projectRoot, filePath, oldContent);

    try {
      await createThread(connection, {
        filePath,
        startLine: 3,
        endLine: 4,
        lineSide: "new",
        title: "Break this anchor",
        body: "This anchor should go outdated after the change.",
        type: "risk"
      });

      writeProjectFile(connection.projectRoot, filePath, newContent);
      await reconcileArtifactsForFileChange(connection, {
        filePath,
        oldContent,
        newContent,
        patch
      });

      const [updated] = await listThreads(connection, {
        status: "all",
        filePath,
        limit: 1
      });

      expect(updated?.freshness).toBe("outdated");
      expect(updated?.startLine).toBe(3);
      expect(updated?.endLine).toBe(4);
    } finally {
      connection.close();
    }
  });

  it("updates thread status and preserves message history when reopened", async () => {
    const connection = createTestConnection();

    try {
      const thread = await createThread(connection, {
        filePath: "src/thread.ts",
        startLine: 8,
        endLine: 10,
        lineSide: "new",
        title: "Need a user follow-up",
        body: "Please confirm whether this should stay public.",
        type: "question"
      });
      await addThreadMessage(connection, {
        threadId: thread.id,
        body: "Keep it public for now.",
        author: "user"
      });

      const resolved = await updateThreadStatus(connection, {
        threadId: thread.id,
        status: "resolved"
      });
      const reopened = await updateThreadStatus(connection, {
        threadId: thread.id,
        status: "open"
      });

      expect(resolved.status).toBe("resolved");
      expect(resolved.messages).toHaveLength(2);
      expect(reopened.status).toBe("open");
      expect(reopened.messages.map((message) => message.author)).toEqual([
        "agent",
        "user"
      ]);
    } finally {
      connection.close();
    }
  });

  it("filters by pending participant based on the last message author", async () => {
    const connection = createTestConnection();

    try {
      const pendingForAgent = await createThread(connection, {
        filePath: "src/agent.ts",
        startLine: 1,
        endLine: 2,
        lineSide: "new",
        title: "Need user input",
        body: "Can you confirm this design?",
        type: "risk"
      });
      await addThreadMessage(connection, {
        threadId: pendingForAgent.id,
        body: "Please keep it as-is.",
        author: "user"
      });

      const pendingForUser = await createThread(connection, {
        filePath: "src/user.ts",
        startLine: 3,
        endLine: 4,
        lineSide: "new",
        title: "Awaiting user reply",
        body: "I recommend changing the API shape.",
        type: "decision"
      });

      const resolvedThread = await createThread(connection, {
        filePath: "src/resolved.ts",
        startLine: 5,
        endLine: 6,
        lineSide: "new",
        title: "Resolved follow-up",
        body: "This is already settled.",
        type: "risk",
        status: "resolved"
      });
      await addThreadMessage(connection, {
        threadId: resolvedThread.id,
        body: "Closing this out.",
        author: "user"
      });

      const agentPending = await listThreads(connection, {
        status: "all",
        pendingFor: "agent"
      });
      const userPending = await listThreads(connection, {
        status: "all",
        pendingFor: "user"
      });

      expect(agentPending.map((thread) => thread.id)).toEqual([pendingForAgent.id]);
      expect(userPending.map((thread) => thread.id)).toContain(pendingForUser.id);
      expect(userPending.map((thread) => thread.id)).not.toContain(resolvedThread.id);
    } finally {
      connection.close();
    }
  });

  it("applies metadata filters before returning thread summaries", async () => {
    const connection = createTestConnection();

    try {
      await createThread(connection, {
        filePath: "src/keep.ts",
        startLine: 10,
        endLine: 12,
        lineSide: "new",
        title: "Keep this risk",
        body: "Relevant thread",
        type: "risk"
      });

      await createThread(connection, {
        filePath: "src/keep.ts",
        startLine: 14,
        endLine: 16,
        lineSide: "new",
        title: "Wrong type",
        body: "Should not match",
        type: "decision"
      });

      await createThread(connection, {
        filePath: "src/skip.ts",
        startLine: 20,
        endLine: 22,
        lineSide: "new",
        title: "Wrong file",
        body: "Should not match",
        type: "risk"
      });

      const matches = await listThreads(connection, {
        status: "all",
        type: "risk",
        filePath: "src/keep.ts",
        limit: 5
      });

      expect(matches).toHaveLength(1);
      expect(matches[0]?.title).toBe("Keep this risk");
    } finally {
      connection.close();
    }
  });
});

describe("listFileBriefs", () => {
  it("marks briefs outdated after the file changes", async () => {
    const connection = createTestConnection();
    const filePath = "src/brief.ts";
    const oldContent = ["export const value = 1;", ""].join("\n");
    const newContent = ["export const value = 2;", ""].join("\n");
    const patch = [
      "Index: src/brief.ts",
      "===================================================================",
      "--- src/brief.ts",
      "+++ src/brief.ts",
      "@@ -1,1 +1,1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      ""
    ].join("\n");

    writeProjectFile(connection.projectRoot, filePath, oldContent);

    try {
      await upsertFileBrief(connection, {
        filePath,
        summary: "Owns a tiny value export."
      });

      writeProjectFile(connection.projectRoot, filePath, newContent);
      await reconcileArtifactsForFileChange(connection, {
        filePath,
        oldContent,
        newContent,
        patch
      });

      const [brief] = await listFileBriefs(connection, {
        filePath,
        freshness: "outdated",
        limit: 1
      });

      expect(brief?.freshness).toBe("outdated");
    } finally {
      connection.close();
    }
  });

  it("can filter file briefs using an updated-at threshold", async () => {
    const connection = createTestConnection();

    try {
      const staleBrief = await upsertFileBrief(connection, {
        filePath: "stale.ts",
        summary: "Stale file summary"
      });
      const freshBrief = await upsertFileBrief(connection, {
        filePath: "fresh.ts",
        summary: "Fresh file summary"
      });

      const staleThreshold = new Date().toISOString();
      await connection.db
        .updateTable("file_briefs")
        .set({ updated_at: staleThreshold })
        .where("id", "=", staleBrief.id)
        .execute();

      await connection.db
        .updateTable("file_briefs")
        .set({
          updated_at: new Date(Date.now() + 60_000).toISOString()
        })
        .where("id", "=", freshBrief.id)
        .execute();

      const withThreshold = await listFileBriefs(connection, {
        limit: 20,
        updatedSince: new Date(Date.now() + 30_000).toISOString()
      });

      const all = await listFileBriefs(connection, 20);

      expect(all).toHaveLength(2);
      expect(withThreshold).toHaveLength(1);
      expect(withThreshold[0]?.filePath).toBe("fresh.ts");
    } finally {
      connection.close();
    }
  });
});

describe("listTodos", () => {
  it("surfaces pending replies, waiting threads, outdated anchors, and outdated briefs", async () => {
    const connection = createTestConnection();
    const filePath = "src/todos.ts";
    const oldContent = ["one", "two", "three", "four", ""].join("\n");
    const newContent = ["one", "TWO", "three", "four", ""].join("\n");
    const patch = [
      "Index: src/todos.ts",
      "===================================================================",
      "--- src/todos.ts",
      "+++ src/todos.ts",
      "@@ -1,4 +1,4 @@",
      " one",
      "-two",
      "+TWO",
      " three",
      " four",
      ""
    ].join("\n");

    writeProjectFile(connection.projectRoot, filePath, oldContent);

    try {
      const waitingOnUser = await createThread(connection, {
        filePath,
        startLine: 3,
        endLine: 4,
        lineSide: "new",
        title: "Waiting on user",
        body: "Initial agent note.",
        type: "decision"
      });
      const pendingForAgent = await createThread(connection, {
        filePath,
        startLine: 3,
        endLine: 4,
        lineSide: "new",
        title: "Pending for agent",
        body: "Need user feedback first.",
        type: "risk"
      });
      await addThreadMessage(connection, {
        threadId: pendingForAgent.id,
        body: "Confirmed, please update it.",
        author: "user"
      });

      await createThread(connection, {
        filePath,
        startLine: 2,
        endLine: 3,
        lineSide: "new",
        title: "Will go outdated",
        body: "This anchor should break.",
        type: "question"
      });

      await upsertFileBrief(connection, {
        filePath,
        summary: "Owns the todo-demo file."
      });

      writeProjectFile(connection.projectRoot, filePath, newContent);
      await reconcileArtifactsForFileChange(connection, {
        filePath,
        oldContent,
        newContent,
        patch
      });

      const items = await listTodos(connection, { filePath, limit: 10 });
      const kinds = items.map((item) => item.kind);

      expect(kinds).toContain("thread_waiting_on_user");
      expect(kinds).toContain("thread_reply_needed");
      expect(kinds).toContain("thread_anchor_outdated");
      expect(kinds).toContain("brief_outdated");
      expect(items.find((item) => item.kind === "thread_waiting_on_user")?.artifactId).toBe(
        waitingOnUser.id
      );
    } finally {
      connection.close();
    }
  });

  it("keeps threads and briefs project-global while changed files stay session-scoped", async () => {
    const connection = createTestConnection();
    const filePath = "src/global-review.ts";

    writeProjectFile(connection.projectRoot, filePath, ["export const value = 1;", ""].join("\n"));

    try {
      const firstSession = await createSession(connection, {
        agentKind: "codex"
      });

      await createThread(connection, {
        sessionId: firstSession.id,
        filePath,
        startLine: 1,
        endLine: 1,
        lineSide: "new",
        title: "Global thread",
        body: "Keep this discussion visible across runs.",
        type: "decision"
      });
      await upsertFileBrief(connection, {
        filePath,
        summary: "Durable brief for this file."
      });

      const secondSession = await createSession(connection, {
        agentKind: "codex"
      });

      await appendEvent(connection, {
        sessionId: secondSession.id,
        kind: "file_diff",
        source: "watcher",
        payload: {
          filePath,
          eventType: "change",
          patch: [
            `Index: ${filePath}`,
            "===================================================================",
            `--- ${filePath}`,
            `+++ ${filePath}`,
            "@@ -1 +1 @@",
            "-export const value = 1;",
            "+export const value = 2;",
            ""
          ].join("\n"),
          added: 1,
          removed: 1
        }
      });

      const overview = await getProjectOverview(connection, secondSession.id);

      expect(overview.changedFiles.map((item) => item.filePath)).toEqual([filePath]);
      expect(overview.threads.map((thread) => thread.filePath)).toContain(filePath);
      expect(overview.fileBriefs.map((brief) => brief.filePath)).toContain(filePath);
    } finally {
      connection.close();
    }
  });
});
