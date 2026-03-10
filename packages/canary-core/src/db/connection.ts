import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { CanaryDatabase } from "../types/database.js";

export interface CanaryConnection {
  projectRoot: string;
  canaryDir: string;
  dbFile: string;
  sqlite: Database.Database;
  db: Kysely<CanaryDatabase>;
  close(): void;
}

export function openConnection(projectRoot: string): CanaryConnection {
  const canaryDir = path.join(projectRoot, ".canary");
  fs.mkdirSync(canaryDir, { recursive: true });

  const dbFile = path.join(canaryDir, "canary.db");
  const sqlite = new Database(dbFile);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = new Kysely<CanaryDatabase>({
    dialect: new SqliteDialect({
      database: sqlite
    })
  });

  return {
    projectRoot,
    canaryDir,
    dbFile,
    sqlite,
    db,
    close() {
      void db.destroy();
      sqlite.close();
    }
  };
}

export function getMigrationsDir(): string {
  const candidates = [
    fileURLToPath(new URL("../migrations", import.meta.url)),
    fileURLToPath(new URL("../../migrations", import.meta.url))
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}
