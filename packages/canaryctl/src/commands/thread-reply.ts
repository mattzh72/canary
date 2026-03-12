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
  await withConnection(input.cwd, async ({ connection, resolveWriteCaller }) => {
    const caller = await resolveWriteCaller();
    const message = await addThreadMessage(connection, {
      threadId: input.threadId,
      body: input.body,
      source: "canaryctl",
      author: caller.author,
      authorId: caller.authorId,
      authorType: caller.authorType,
      authorAvatarSvg: caller.authorAvatarSvg
    });

    if (input.json) {
      printJson(message);
      return;
    }

    printRecord(message.id, input.threadId, `${message.author} · ${input.body}`);
  });
}
