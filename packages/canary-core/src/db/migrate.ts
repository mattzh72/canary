import fs from "node:fs";
import path from "node:path";
import type { CanaryConnection } from "./connection.js";
import { getMigrationsDir } from "./connection.js";

export function applyMigrations(connection: CanaryConnection): void {
  const migrationsDir = getMigrationsDir();
  const files = fs
    .readdirSync(migrationsDir, { encoding: "utf8" })
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  connection.sqlite.exec(
    "CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );

  const applied = new Set(
    connection.sqlite
      .prepare("SELECT id FROM migrations")
      .all()
      .map((row) => String((row as { id: string }).id))
  );

  const insert = connection.sqlite.prepare(
    "INSERT INTO migrations (id, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const now = new Date().toISOString();
    const transaction = connection.sqlite.transaction(() => {
      connection.sqlite.exec(sql);
      insert.run(file, now);
    });
    transaction();
  }
}
