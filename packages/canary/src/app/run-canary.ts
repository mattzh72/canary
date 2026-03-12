import {
  appendEvent,
  applyMigrations,
  createMonitorSession,
  finishSession,
  openConnection,
  resolveProjectRoot,
  startAgentSession
} from "canary-core";
import type { AgentKind, SessionStatus } from "canary-core";
import { startFileWatcher } from "../capture/file-watcher.js";
import { runAgentProcess } from "../runtime/agent-process.js";
import { openBrowser } from "../runtime/open-browser.js";
import { createCanaryServer } from "../server/create-server.js";

interface RunServeParams {
  openUi: boolean;
  port?: number;
}

interface RunAgentWrapperParams {
  agent: AgentKind;
  agentArgs: string[];
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const handleSignal = (signal: NodeJS.Signals) => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      resolve(signal);
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

export async function runServe({ openUi, port }: RunServeParams): Promise<number> {
  const launchCwd = process.cwd();
  const projectRoot = resolveProjectRoot(launchCwd);
  const connection = openConnection(projectRoot);
  applyMigrations(connection);

  const session = await createMonitorSession(connection, {
    cwd: launchCwd
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
        message: "serve_started",
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
    process.stdout.write(`[canary] watching ${projectRoot}\n`);

    if (openUi) {
      await openBrowser(server.url);
    }

    watcher = await startFileWatcher({
      connection,
      projectRoot,
      sessionId: session.id
    });

    const signal = await waitForShutdownSignal();
    finalStatus = "aborted";

    await appendEvent(connection, {
      sessionId: session.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: "serve_stopped",
        signal
      }
    });

    return 0;
  } catch (error: unknown) {
    finalStatus = "failed";
    await appendEvent(connection, {
      sessionId: session.id,
      kind: "warning",
      source: "canary",
      payload: {
        message: "serve_failed",
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

export async function runAgentWrapper({
  agent,
  agentArgs
}: RunAgentWrapperParams): Promise<number> {
  const launchCwd = process.cwd();
  const projectRoot = resolveProjectRoot(launchCwd);
  const connection = openConnection(projectRoot);
  applyMigrations(connection);

  const { session, sessionToken } = await startAgentSession(connection, agent, {
    args: agentArgs,
    launchCwd
  });

  let finalStatus: SessionStatus = "completed";

  try {
    await appendEvent(connection, {
      sessionId: session.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: "agent_wrapper_started",
        agent,
        args: agentArgs,
        cwd: launchCwd,
        actorName: session.actorName
      }
    });

    process.stdout.write(`[canary] ${session.actorName} attached to ${projectRoot}\n`);

    const result = await runAgentProcess({
      agent,
      args: agentArgs,
      cwd: launchCwd,
      env: {
        ...process.env,
        CANARY_PROJECT_ROOT: projectRoot,
        CANARY_SESSION_ID: session.id,
        CANARY_ACTOR_ID: session.actorId ?? "",
        CANARY_SESSION_TOKEN: sessionToken
      }
    });

    finalStatus = result.exitCode === 0 ? "completed" : "failed";

    await appendEvent(connection, {
      sessionId: session.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: "agent_wrapper_finished",
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
        message: "agent_wrapper_failed",
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  } finally {
    await finishSession(connection, session.id, finalStatus);
    connection.close();
  }
}
