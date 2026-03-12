#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  appendEvent,
  applyMigrations,
  createMonitorSession,
  finishSession,
  getProjectOverview,
  openConnection,
  reconcileArtifactsForFileChange,
  startAgentSession
} from "../packages/canary-core/dist/index.js";
import { scenarioCatalog } from "./scenarios/index.mjs";
import { createCanaryServer } from "../packages/canary/dist/server/index.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const templateRoot = path.join(__dirname, "template");
const workspaceRoot = path.join(__dirname, "workspace");
const demoCanaryHome = path.join(
  os.tmpdir(),
  "canary-live-demo",
  createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)
);
const clientDistDir = path.join(repoRoot, "packages", "canary", "dist", "client");
const canaryctlCli = path.join(repoRoot, "packages", "canaryctl", "dist", "cli", "index.js");
const canaryPackageRequire = createRequire(
  path.join(repoRoot, "packages", "canary", "package.json")
);
process.env.CANARY_HOME = demoCanaryHome;
process.env.CANARY_PROJECT_ROOT = workspaceRoot;

const { default: chokidar } = await import(
  pathToFileURL(canaryPackageRequire.resolve("chokidar")).href
);
const { createTwoFilesPatch } = await import(
  pathToFileURL(canaryPackageRequire.resolve("diff")).href
);
const getPortModule = await import(
  pathToFileURL(canaryPackageRequire.resolve("get-port")).href
);
const getPort = getPortModule.default;
const { portNumbers } = getPortModule;

const MAX_TEXT_FILE_BYTES = 512 * 1024;
const IGNORED_SEGMENTS = new Set([".git", "node_modules", ".canary", "dist", "coverage"]);
const WATCHER_SETTLE_MS = 225;

function usage() {
  process.stdout.write(`Usage:
  node live-demo/index.mjs list
  node live-demo/index.mjs reset
  node live-demo/index.mjs start [scenario] [--interval <ms>] [--port <number>] [--open] [--no-hold]
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "start";
  let scenarioName = "default";
  let intervalMs = 1200;
  let port;
  let hold = true;
  let openUi = false;

  while (args.length > 0) {
    const current = args.shift();
    if (!current) {
      continue;
    }

    if (current === "--interval") {
      const value = Number(args.shift());
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("`--interval` expects a positive number.");
      }
      intervalMs = value;
      continue;
    }

    if (current === "--port") {
      const value = Number(args.shift());
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("`--port` expects a positive number.");
      }
      port = value;
      continue;
    }

    if (current === "--no-hold") {
      hold = false;
      continue;
    }

    if (current === "--open") {
      openUi = true;
      continue;
    }

    if (current.startsWith("--")) {
      throw new Error(`Unknown option: ${current}`);
    }

    scenarioName = current;
  }

  return {
    command,
    scenarioName,
    intervalMs,
    port,
    hold,
    openUi
  };
}

function shouldIgnore(absolutePath) {
  return absolutePath.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment));
}

async function readTextFile(filePath) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_TEXT_FILE_BYTES) {
      return null;
    }

    const buffer = await fs.readFile(filePath);
    if (buffer.includes(0)) {
      return null;
    }

    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

async function snapshotProjectFiles(projectRoot) {
  const files = new Map();
  const stack = [projectRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (shouldIgnore(absolutePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const content = await readTextFile(absolutePath);
      if (content !== null) {
        files.set(absolutePath, content);
      }
    }
  }

  return files;
}

function summarizePatch(patchText) {
  let added = 0;
  let removed = 0;

  for (const line of patchText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }

  return { added, removed };
}

function createPatch(filePath, oldContent, newContent) {
  const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, "", "", {
    context: 3
  });
  const summary = summarizePatch(patch);
  return {
    patch,
    added: summary.added,
    removed: summary.removed
  };
}

async function startFileWatcher({ connection, projectRoot, sessionId }) {
  const snapshots = await snapshotProjectFiles(projectRoot);
  const watcher = chokidar.watch(projectRoot, {
    ignored: (value) => shouldIgnore(value),
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50
    }
  });

  async function emitFileDiff(eventType, absolutePath, oldContent, newContent) {
    const relativePath = path.relative(projectRoot, absolutePath);
    const { patch, added, removed } = createPatch(relativePath, oldContent, newContent);
    if (added === 0 && removed === 0) {
      return;
    }

    await appendEvent(connection, {
      sessionId,
      kind: "file_diff",
      source: "watcher",
      payload: {
        filePath: relativePath,
        eventType,
        patch,
        added,
        removed
      }
    });

    await reconcileArtifactsForFileChange(connection, {
      filePath: relativePath,
      oldContent,
      newContent,
      patch
    });
  }

  watcher.on("add", async (absolutePath) => {
    const next = await readTextFile(absolutePath);
    if (next === null) {
      return;
    }

    const previous = snapshots.get(absolutePath) ?? "";
    snapshots.set(absolutePath, next);
    await emitFileDiff("add", absolutePath, previous, next);
  });

  watcher.on("change", async (absolutePath) => {
    const next = await readTextFile(absolutePath);
    if (next === null) {
      return;
    }

    const previous = snapshots.get(absolutePath);
    snapshots.set(absolutePath, next);
    if (typeof previous !== "string" || previous === next) {
      return;
    }

    await emitFileDiff("change", absolutePath, previous, next);
  });

  watcher.on("unlink", async (absolutePath) => {
    const previous = snapshots.get(absolutePath);
    snapshots.delete(absolutePath);
    if (typeof previous !== "string") {
      return;
    }

    await emitFileDiff("unlink", absolutePath, previous, "");
  });

  return {
    close: () => watcher.close()
  };
}

async function resetWorkspace() {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(demoCanaryHome, { recursive: true, force: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.cp(templateRoot, workspaceRoot, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureBuiltArtifacts() {
  const requiredFiles = [
    path.join(clientDistDir, "index.html"),
    canaryctlCli,
    path.join(repoRoot, "packages", "canary", "dist", "server", "index.js")
  ];

  for (const requiredFile of requiredFiles) {
    try {
      await fs.access(requiredFile);
    } catch {
      throw new Error(
        "Canary build artifacts are missing. Run `pnpm build` before using live-demo."
      );
    }
  }
}

function formatStepLabel(index, step) {
  const explicit = step.label ? ` ${step.label}` : "";
  return `[${String(index + 1).padStart(2, "0")}/${step.total}]${explicit}`;
}

function resolveScenario(name) {
  const scenario = scenarioCatalog[name];
  if (!scenario) {
    const available = Object.keys(scenarioCatalog).sort().join(", ");
    throw new Error(`Unknown scenario: ${name}. Available scenarios: ${available}`);
  }
  return scenario;
}

async function writeWorkspaceFile(relativePath, content) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function deleteWorkspaceFile(relativePath) {
  await fs.rm(path.join(workspaceRoot, relativePath), { force: true });
}

async function loadAssetFile(relativePath) {
  return fs.readFile(path.join(__dirname, relativePath), "utf8");
}

async function appendDemoEvent(connection, sessionId, step) {
  await appendEvent(connection, {
    sessionId,
    kind: step.kind,
    source: step.source,
    payload: step.payload
  });
}

async function runCanaryctl(args, capture, sessionToken) {
  const commandArgs = [canaryctlCli, ...args];
  const result = await execFileAsync(process.execPath, commandArgs, {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      CANARY_SESSION_TOKEN: sessionToken ?? process.env.CANARY_SESSION_TOKEN
    }
  });

  const stdout = result.stdout.trim();
  if (stdout) {
    process.stdout.write(`${stdout}\n`);
  }
  if (result.stderr?.trim()) {
    process.stderr.write(`${result.stderr.trim()}\n`);
  }

  if (!capture) {
    return null;
  }

  if (!stdout) {
    throw new Error("Expected JSON output from canaryctl capture step.");
  }

  const parsed = JSON.parse(stdout);
  if (capture.kind === "id") {
    if (!parsed.id || typeof parsed.id !== "string") {
      throw new Error(`Capture "${capture.as}" expected an "id" in canaryctl output.`);
    }
    return {
      [capture.as]: parsed.id
    };
  }

  return {
    [capture.as]: parsed
  };
}

async function maybeOpenBrowser(url) {
  const { default: open } = await import(
    pathToFileURL(canaryPackageRequire.resolve("open")).href
  );
  await open(url);
}

async function executeStep(context, step, index, total) {
  const label = formatStepLabel(index, { ...step, total });
  process.stdout.write(`${label} ${step.type}\n`);

  switch (step.type) {
    case "sleep":
      await sleep(step.ms);
      return;
    case "write_file": {
      const content =
        typeof step.content === "string" ? step.content : await loadAssetFile(step.asset);
      await writeWorkspaceFile(step.path, content);
      return;
    }
    case "delete_file":
      await deleteWorkspaceFile(step.path);
      return;
    case "append_event":
      await appendDemoEvent(context.connection, context.monitorSession.id, step);
      return;
    case "canaryctl": {
      const args = [...step.args];
      if (step.capture) {
        args.push("--json");
      }
      if (step.threadIdFrom) {
        const threadId = context.captures[step.threadIdFrom];
        if (typeof threadId !== "string" || !threadId) {
          throw new Error(`Missing captured thread id: ${step.threadIdFrom}`);
        }
        args.splice(2, 0, threadId);
      }
      const captureResult = await runCanaryctl(
        args,
        step.capture ?? null,
        context.agentSessionToken
      );
      if (captureResult) {
        Object.assign(context.captures, captureResult);
      }
      return;
    }
    default:
      throw new Error(`Unsupported step type: ${step.type}`);
  }
}

async function buildSummary(connection, sessionId) {
  const overview = await getProjectOverview(connection, sessionId);
  return {
    sessionId,
    changedFiles: overview.changedFiles.length,
    reviewItems: overview.threads.length,
    threads: overview.threads.length,
    fileBriefs: overview.fileBriefs.length,
    recentEvents: overview.recentEvents.length
  };
}

async function runScenario({
  scenarioName,
  intervalMs,
  requestedPort,
  hold,
  openUi
}) {
  const scenario = resolveScenario(scenarioName);
  await ensureBuiltArtifacts();
  await resetWorkspace();

  const connection = openConnection(workspaceRoot);
  applyMigrations(connection);

  const monitorSession = await createMonitorSession(connection, {
    mode: "live-demo",
    scenario: scenario.name,
    seed: scenario.seed,
    templateRoot: path.relative(repoRoot, templateRoot)
  });
  const { session: agentSession, sessionToken: agentSessionToken } = await startAgentSession(
    connection,
    "codex",
    {
      mode: "live-demo",
      scenario: scenario.name,
      seed: scenario.seed,
      templateRoot: path.relative(repoRoot, templateRoot)
    }
  );

  let finalStatus = "completed";
  let server = null;
  let watcher = null;
  let resourcesClosed = false;
  let sessionsFinalized = false;

  const context = {
    connection,
    monitorSession,
    agentSession,
    agentSessionToken,
    captures: {}
  };

  const finalizeSessions = async (status) => {
    if (sessionsFinalized) {
      return;
    }
    sessionsFinalized = true;
    finalStatus = status;
    await appendEvent(connection, {
      sessionId: monitorSession.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: status === "aborted" ? "session_aborted" : "session_finished",
        scenario: scenario.name
      }
    });
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    await finishSession(connection, monitorSession.id, finalStatus);
    await finishSession(connection, agentSession.id, finalStatus);
  };

  const closeResources = async () => {
    if (resourcesClosed) {
      return;
    }
    resourcesClosed = true;
    if (server) {
      await server.close();
      server = null;
    }
    connection.close();
  };

  const shutdown = async (status) => {
    if (status) {
      await finalizeSessions(status);
    }
    const summary = await buildSummary(connection, monitorSession.id);
    await closeResources();
    return summary;
  };

  const handleSignal = async () => {
    process.stdout.write("\nStopping live demo...\n");
    const summary = await shutdown(sessionsFinalized ? null : "aborted");
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exit(sessionsFinalized ? 0 : 130);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  let serverPort = null;

  try {
    await appendEvent(connection, {
      sessionId: monitorSession.id,
      kind: "session_status",
      source: "canary",
      payload: {
        message: "session_started",
        scenario: scenario.name,
        intervalMs,
        actorName: agentSession.actorName
      }
    });

    serverPort = requestedPort ?? (await getPort({ port: portNumbers(4300, 4399) }));

    server = await createCanaryServer({
      connection,
      sessionId: monitorSession.id,
      requestedPort: serverPort
    });

    watcher = await startFileWatcher({
      connection,
      projectRoot: workspaceRoot,
      sessionId: monitorSession.id
    });

    process.env.CANARY_SESSION_TOKEN = agentSessionToken;

    process.stdout.write(`Live demo ready at ${server.url}\n`);
    process.stdout.write(`Workspace: ${workspaceRoot}\n`);
    process.stdout.write(`Scenario: ${scenario.name} (${scenario.seed})\n`);
    process.stdout.write(`Monitor: ${monitorSession.actorName ?? "canary-watchtower"}\n`);
    process.stdout.write(`Agent: ${agentSession.actorName ?? "codex"}\n`);

    if (openUi) {
      await maybeOpenBrowser(server.url);
    }

    for (let index = 0; index < scenario.steps.length; index += 1) {
      const step = scenario.steps[index];
      await executeStep(context, step, index, scenario.steps.length);
      const pauseMs =
        typeof step.pauseMs === "number"
          ? step.pauseMs
          : step.type === "sleep"
            ? 0
            : step.type === "write_file" || step.type === "delete_file"
              ? Math.max(intervalMs, WATCHER_SETTLE_MS)
              : intervalMs;
      if (pauseMs > 0) {
        await sleep(pauseMs);
      }
    }

    await sleep(WATCHER_SETTLE_MS);

    await finalizeSessions("completed");
    const summary = await buildSummary(connection, monitorSession.id);

    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (!hold) {
      await closeResources();
      return;
    }

    process.stdout.write("Scenario complete. Press Ctrl+C to stop the demo server.\n");
    await new Promise(() => {});
  } catch (error) {
    finalStatus = "failed";
    await appendEvent(connection, {
      sessionId: monitorSession.id,
      kind: "warning",
      source: "canary",
      payload: {
        message: "demo_failed",
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  } finally {
    delete process.env.CANARY_SESSION_TOKEN;
    if (!resourcesClosed && (!hold || finalStatus === "failed")) {
      await shutdown(sessionsFinalized ? null : finalStatus === "failed" ? "failed" : "aborted");
    }
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.command === "list") {
    const names = Object.keys(scenarioCatalog).sort();
    for (const name of names) {
      process.stdout.write(`${name}  ${scenarioCatalog[name].description}\n`);
    }
    return;
  }

  if (parsed.command === "reset") {
    await resetWorkspace();
    process.stdout.write(`Reset ${workspaceRoot}\n`);
    return;
  }

  if (parsed.command !== "start") {
    usage();
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  await runScenario({
    scenarioName: parsed.scenarioName,
    intervalMs: parsed.intervalMs,
    requestedPort: parsed.port,
    hold: parsed.hold,
    openUi: parsed.openUi
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
