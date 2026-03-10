import { addThreadMessage } from "canary-core";
import { printJson, printRecord } from "../output/render.js";
import { withConnection } from "./context.js";

interface ThreadReplyInput {
  cwd: string;
  threadId: string;
  body: string;
  json?: boolean;
}

export async function runThreadReply(input: ThreadReplyInput): Promise<void> {
  await withConnection(input.cwd, async ({ connection }) => {
    const message = await addThreadMessage(connection, {
      threadId: input.threadId,
      body: input.body,
      source: "canaryctl",
      author: "agent"
    });

    if (input.json) {
      printJson(message);
      return;
    }

    printRecord(message.id, input.threadId, input.body);
  });
}
