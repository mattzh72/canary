import { applyMigrations, getLatestSession, openConnection, resolveProjectRoot } from "canary-core";

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
