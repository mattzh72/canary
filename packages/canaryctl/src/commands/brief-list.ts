import { listFileBriefs } from "canary-core";
import type { ArtifactFreshness, FileBriefRecord } from "canary-core";
import { printJson } from "../output/render.js";
import { withConnection } from "./context.js";
import { normalizeProjectPath } from "./target.js";

interface BriefListInput {
  cwd: string;
  file?: string;
  freshness?: ArtifactFreshness | "all";
  limit?: number;
  json?: boolean;
}

interface BriefListItem {
  id: string;
  filePath: string;
  summary: string;
  freshness: ArtifactFreshness;
  updatedAt: string;
}

function summarizeBrief(brief: FileBriefRecord): BriefListItem {
  return {
    id: brief.id,
    filePath: brief.filePath,
    summary: brief.summary,
    freshness: brief.freshness,
    updatedAt: brief.updatedAt
  };
}

function printBriefList(items: BriefListItem[]): void {
  if (items.length === 0) {
    process.stdout.write("No file briefs.\n");
    return;
  }

  for (const item of items) {
    process.stdout.write(
      `${item.id}  ${item.filePath}\n${item.freshness} · ${item.summary}\n\n`
    );
  }
}

export async function runBriefList(input: BriefListInput): Promise<void> {
  await withConnection(input.cwd, async ({ connection, projectRoot }) => {
    const filePath = input.file ? normalizeProjectPath(projectRoot, input.file) : undefined;
    const briefs = await listFileBriefs(connection, {
      limit: input.limit,
      filePath,
      freshness: input.freshness
    });
    const items = briefs.map(summarizeBrief);

    if (input.json) {
      printJson(items);
      return;
    }

    printBriefList(items);
  });
}
