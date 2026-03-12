import fs from "node:fs/promises";
import path from "node:path";

const MAX_TEXT_FILE_BYTES = 512 * 1024;
const IGNORED_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".canary",
  "dist",
  "coverage"
]);

function shouldIgnore(absolutePath: string): boolean {
  return absolutePath
    .split(path.sep)
    .some((segment) => IGNORED_SEGMENTS.has(segment));
}

function isProbablyText(buffer: Buffer): boolean {
  return !buffer.includes(0);
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > MAX_TEXT_FILE_BYTES) {
      return null;
    }

    const buffer = await fs.readFile(filePath);
    if (!isProbablyText(buffer)) {
      return null;
    }

    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

export async function listProjectFiles(projectRoot: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [projectRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current, {
        withFileTypes: true
      });
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

      files.push(path.relative(projectRoot, absolutePath));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

export async function snapshotProjectFiles(projectRoot: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const stack = [projectRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current, {
        withFileTypes: true
      });
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
      if (content === null) {
        continue;
      }

      files.set(absolutePath, content);
    }
  }

  return files;
}
