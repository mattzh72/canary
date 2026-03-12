import { applyMigrations, openConnection, resolveCallerIdentity, resolveProjectRoot } from "canary-core";

export async function withConnection<T>(
  cwd: string,
  run: (context: {
    projectRoot: string;
    close(): void;
    connection: ReturnType<typeof openConnection>;
    caller: Awaited<ReturnType<typeof resolveCallerIdentity>>;
    resolveWriteCaller(): ReturnType<typeof resolveCallerIdentity>;
  }) => Promise<T>
): Promise<T> {
  const projectRoot = resolveProjectRoot(cwd);
  const connection = openConnection(projectRoot);
  applyMigrations(connection);
  const sessionToken = process.env.CANARY_SESSION_TOKEN;
  const caller = await resolveCallerIdentity(connection, sessionToken, false);

  try {
    return await run({
      projectRoot,
      close: () => connection.close(),
      connection,
      caller,
      resolveWriteCaller: () => resolveCallerIdentity(connection, sessionToken, true)
    });
  } finally {
    connection.close();
  }
}
