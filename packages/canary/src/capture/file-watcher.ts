import path from "node:path";
import chokidar from "chokidar";
import { createTwoFilesPatch } from "diff";
import { appendEvent, reconcileArtifactsForFileChange } from "@canaryctl/core";
import type { CanaryConnection } from "@canaryctl/core";
import { readTextFile, snapshotProjectFiles } from "./project-snapshot.js";

interface StartFileWatcherParams {
  connection: CanaryConnection;
  projectRoot: string;
  sessionId: string;
}

function summarizePatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }

  return {
    added,
    removed
  };
}

function createPatch(
  filePath: string,
  oldContent: string,
  newContent: string
): { patch: string; added: number; removed: number } {
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

export async function startFileWatcher({
  connection,
  projectRoot,
  sessionId
}: StartFileWatcherParams): Promise<{ close(): Promise<void> }> {
  const snapshots = await snapshotProjectFiles(projectRoot);
  const watcher = chokidar.watch(projectRoot, {
    ignored: (value) =>
      value.includes(`${path.sep}.git${path.sep}`) ||
      value.includes(`${path.sep}node_modules${path.sep}`) ||
      value.includes(`${path.sep}.canary${path.sep}`) ||
      value.includes(`${path.sep}dist${path.sep}`),
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 150,
      pollInterval: 50
    }
  });

  async function emitFileDiff(
    eventType: "add" | "change" | "unlink",
    absolutePath: string,
    oldContent: string,
    newContent: string
  ): Promise<void> {
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
