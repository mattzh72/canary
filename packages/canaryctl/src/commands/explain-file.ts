import { upsertFileBrief } from "canary-core";
import { printJson, printRecord } from "../output/render.js";
import { withConnection } from "./context.js";
import { normalizeFilePath } from "./target.js";

interface ExplainFileInput {
  cwd: string;
  file: string;
  summary: string;
  details?: string;
  json?: boolean;
}

export async function runExplainFile(input: ExplainFileInput): Promise<void> {
  await withConnection(input.cwd, async ({ connection, projectRoot }) => {
    const filePath = normalizeFilePath(projectRoot, input.file);
    const brief = await upsertFileBrief(connection, {
      filePath,
      summary: input.summary,
      details: input.details ?? null,
      source: "canaryctl",
      author: "agent"
    });

    if (input.json) {
      printJson(brief);
      return;
    }

    printRecord(brief.id, brief.filePath, brief.summary);
  });
}
