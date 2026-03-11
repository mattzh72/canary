import {
  appendEvent,
  applyMigrations,
  createSession,
  finishSession,
  openConnection,
  resolveProjectRoot
} from "canary-core";
import type { AgentKind, SessionStatus } from "canary-core";
import { startFileWatcher } from "../capture/file-watcher.js";
import { runAgentProcess } from "../runtime/agent-process.js";
import { openBrowser } from "../runtime/open-browser.js";
import { createCanaryServer } from "../server/create-server.js";

interface RunCanaryParams {
  agent: AgentKind;
  agentArgs: string[];
  openUi: boolean;
  port?: number;
}

export async function runCanary({
  agent,
  agentArgs,
  openUi,
  port
}: RunCanaryParams): Promise<number> {
  const launchCwd = process.cwd();
  const projectRoot = resolveProjectRoot(launchCwd);
  const connection = openConnection(projectRoot);
  applyMigrations(connection);

  const session = await createSession(connection, {
    agentKind: agent,
    metadata: {
      args: agentArgs,
      launchCwd
    }
  });

  let finalStatus: SessionStatus = "completed";
  let server: Awaited<ReturnType<typeof createCanaryServer>> | null = null;
  let watcher: Awaited<ReturnType<typeof startFileWatcher>> | null = null;

  try {
    await appendEvent(connection, {
      sessionId: session.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: "session_started",
        agent,
        args: agentArgs,
        cwd: launchCwd,
        projectRoot
      }
    });

    server = await createCanaryServer({
      connection,
      sessionId: session.id,
      requestedPort: port
    });

    process.stdout.write(`[canary] UI: ${server.url}\n`);

    if (openUi) {
      await openBrowser(server.url);
    }

    watcher = await startFileWatcher({
      connection,
      projectRoot,
      sessionId: session.id
    });

    const result = await runAgentProcess({
      agent,
      args: agentArgs,
      cwd: launchCwd
    });

    finalStatus = result.exitCode === 0 ? "completed" : "failed";

    await appendEvent(connection, {
      sessionId: session.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: "session_finished",
        exitCode: result.exitCode,
        signal: result.signal
      }
    });

    return result.exitCode;
  } catch (error: unknown) {
    finalStatus = "failed";
    await appendEvent(connection, {
      sessionId: session.id,
      kind: "warning",
      source: "canary",
      payload: {
        message: "runtime_failed",
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  } finally {
    if (watcher) {
      await watcher.close();
    }
    if (server) {
      await server.close();
    }
    await finishSession(connection, session.id, finalStatus);
    connection.close();
  }
}
