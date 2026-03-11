import { updateThreadStatus } from "canary-core";
import { printJson, printRecord } from "../output/render.js";
import { withConnection } from "./context.js";

interface ThreadSetStatusInput {
  cwd: string;
  threadId: string;
  status: "open" | "resolved";
  json?: boolean;
}

export async function runThreadSetStatus(
  input: ThreadSetStatusInput
): Promise<void> {
  await withConnection(input.cwd, async ({ connection }) => {
    const thread = await updateThreadStatus(connection, {
      threadId: input.threadId,
      status: input.status
    });

    if (input.json) {
      printJson(thread);
      return;
    }

    printRecord(thread.id, thread.status, thread.title);
  });
}
