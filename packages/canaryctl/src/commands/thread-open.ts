import { createThread } from "canary-core";
import type { ThreadType } from "canary-core";
import { printJson, printRecord } from "../output/render.js";
import { withConnection } from "./context.js";
import { createThreadAnchor, normalizeFilePath } from "./target.js";

interface ThreadOpenInput {
  cwd: string;
  file: string;
  startLine: number;
  endLine: number;
  type: ThreadType;
  title: string;
  body: string;
  json?: boolean;
}

export async function runThreadOpen(input: ThreadOpenInput): Promise<void> {
  await withConnection(input.cwd, async ({ connection, projectRoot, resolveWriteCaller }) => {
    const caller = await resolveWriteCaller();
    const filePath = normalizeFilePath(projectRoot, input.file);
    const target = createThreadAnchor(filePath, input.startLine, input.endLine);
    const thread = await createThread(connection, {
      sessionId: caller.sessionId,
      authorId: caller.authorId,
      filePath: target.filePath,
      startLine: input.startLine,
      endLine: input.endLine,
      lineSide: "new",
      anchor: target.anchor,
      title: input.title,
      body: input.body,
      type: input.type,
      source: "canaryctl",
      author: caller.author,
      authorType: caller.authorType,
      authorAvatarSvg: caller.authorAvatarSvg
    });

    if (input.json) {
      printJson(thread);
      return;
    }

    printRecord(
      thread.id,
      thread.title,
      `${thread.filePath}:${thread.startLine}-${thread.endLine} · ${thread.type}`
    );
  });
}
