import fs from "node:fs";
import path from "node:path";
import { applyMigrations, getLatestSession, openConnection } from "canary-core";

function resolveProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);

  while (true) {
    if (
      fs.existsSync(path.join(current, ".canary")) ||
      fs.existsSync(path.join(current, ".git"))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(cwd);
    }
    current = parent;
  }
}

export async function withConnection<T>(
  cwd: string,
  run: (context: {
    projectRoot: string;
    latestSessionId: string | null;
    close(): void;
    connection: ReturnType<typeof openConnection>;
  }) => Promise<T>
): Promise<T> {
  const projectRoot = resolveProjectRoot(cwd);
  const connection = openConnection(projectRoot);
  applyMigrations(connection);
  const latestSession = await getLatestSession(connection);

  try {
    return await run({
      projectRoot,
      latestSessionId: latestSession?.id ?? null,
      close: () => connection.close(),
      connection
    });
  } finally {
    connection.close();
  }
}
