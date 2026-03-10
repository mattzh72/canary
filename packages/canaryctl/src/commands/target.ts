import path from "node:path";
import type { JsonObject } from "canary-core";

export interface ParsedTarget {
  filePath: string;
  anchor: JsonObject;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

export function normalizeFilePath(projectRoot: string, input: string): string {
  const file = input.trim();
  if (!file) {
    throw new Error("Missing required file path.");
  }

  const resolved = path.resolve(projectRoot, file);
  const relativePath = path.relative(projectRoot, resolved);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`File path must stay within the project root: ${input}`);
  }

  return normalizeRelativePath(relativePath);
}

export function createFileAnchor(filePath: string): ParsedTarget {
  return {
    filePath,
    anchor: {
      filePath
    }
  };
}

export function createThreadAnchor(
  filePath: string,
  startLine: number,
  endLine: number
): ParsedTarget {
  return {
    filePath,
    anchor: {
      filePath,
      startLine,
      endLine
    }
  };
}
