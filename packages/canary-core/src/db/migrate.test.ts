import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openConnection } from "./connection.js";
import { applyMigrations } from "./migrate.js";
import { getProjectStateDir } from "./storage.js";

const tempDirs: string[] = [];

function createTempProjectRoot(): string {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canary-core-migrate-"));
  tempDirs.push(projectRoot);
  return projectRoot;
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

describe("applyMigrations", () => {
  it("drops legacy review mark and note tables from existing databases", () => {
    const connection = openConnection(createTempProjectRoot());

    try {
      connection.sqlite.exec(`
        CREATE TABLE migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        INSERT INTO migrations (id, applied_at) VALUES
          ('001_initial.sql', '2026-03-11T00:00:00.000Z'),
          ('002_line_side.sql', '2026-03-11T00:00:00.000Z'),
          ('003_thread_metadata.sql', '2026-03-11T00:00:00.000Z');

        CREATE TABLE review_marks (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL
        );

        CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL
        );

        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          session_id TEXT,
          file_path TEXT,
          start_line INTEGER,
          end_line INTEGER,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          anchor_json TEXT NOT NULL DEFAULT '{}',
          source TEXT NOT NULL,
          author TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          line_side TEXT,
          type TEXT NOT NULL DEFAULT 'decision',
          severity TEXT NOT NULL DEFAULT 'medium'
        );

        INSERT INTO threads (
          id,
          project_root,
          session_id,
          file_path,
          start_line,
          end_line,
          title,
          status,
          anchor_json,
          source,
          author,
          created_at,
          updated_at,
          line_side,
          type,
          severity
        ) VALUES
          (
            'thread-question',
            'project',
            NULL,
            'src/example.ts',
            1,
            2,
            'Question thread',
            'open',
            '{}',
            'canaryctl',
            'agent',
            '2026-03-11T00:00:00.000Z',
            '2026-03-11T00:00:00.000Z',
            'new',
            'assumption',
            'medium'
          ),
          (
            'thread-scope',
            'project',
            NULL,
            'src/example.ts',
            3,
            4,
            'Scope thread',
            'open',
            '{}',
            'canaryctl',
            'agent',
            '2026-03-11T00:00:00.000Z',
            '2026-03-11T00:00:00.000Z',
            'new',
            'scope_extension',
            'medium'
          );

        CREATE TABLE file_briefs (
          id TEXT PRIMARY KEY,
          project_root TEXT NOT NULL,
          file_path TEXT NOT NULL,
          summary TEXT NOT NULL,
          details TEXT,
          source TEXT NOT NULL,
          author TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      applyMigrations(connection);

      const tables = connection.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String((row as { name: string }).name));

      expect(tables).not.toContain("review_marks");
      expect(tables).not.toContain("notes");
      expect(
        connection.sqlite
          .prepare("SELECT COUNT(*) AS count FROM migrations WHERE id = ?")
          .get("004_drop_legacy_artifacts.sql")
      ).toEqual({ count: 1 });
      expect(
        connection.sqlite
          .prepare("SELECT COUNT(*) AS count FROM migrations WHERE id = ?")
          .get("005_artifact_freshness.sql")
      ).toEqual({ count: 1 });
      expect(
        connection.sqlite
          .prepare("SELECT COUNT(*) AS count FROM migrations WHERE id = ?")
          .get("006_remove_thread_severity.sql")
      ).toEqual({ count: 1 });
      expect(
        connection.sqlite
          .prepare("SELECT COUNT(*) AS count FROM migrations WHERE id = ?")
          .get("007_reviewer_first_thread_types.sql")
      ).toEqual({ count: 1 });
      const threadColumns = connection.sqlite
        .prepare("PRAGMA table_info(threads)")
        .all()
        .map((row) => String((row as { name: string }).name));
      const briefColumns = connection.sqlite
        .prepare("PRAGMA table_info(file_briefs)")
        .all()
        .map((row) => String((row as { name: string }).name));
      expect(threadColumns).toContain("freshness");
      expect(threadColumns).not.toContain("severity");
      expect(briefColumns).toContain("freshness");
      expect(
        connection.sqlite
          .prepare("SELECT type FROM threads WHERE id = ?")
          .get("thread-question")
      ).toEqual({ type: "question" });
      expect(
        connection.sqlite
          .prepare("SELECT type FROM threads WHERE id = ?")
          .get("thread-scope")
      ).toEqual({ type: "scope_change" });
    } finally {
      connection.close();
    }
  });
});
