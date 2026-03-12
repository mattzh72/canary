import { listThreads } from "canary-core";
import type {
  ArtifactFreshness,
  ThreadRecord,
  ThreadStatus,
  ThreadType
} from "canary-core";
import { printJson } from "../output/render.js";
import { withConnection } from "./context.js";
import { normalizeProjectPath } from "./target.js";

interface ThreadListInput {
  cwd: string;
  status?: ThreadStatus | "all";
  freshness?: ArtifactFreshness | "all";
  type?: ThreadType;
  file?: string;
  pendingFor?: "agent" | "user";
  limit?: number;
  json?: boolean;
}

interface ThreadListItem {
  id: string;
  title: string;
  status: ThreadStatus;
  freshness: ArtifactFreshness;
  type: ThreadType;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  updatedAt: string;
  messageCount: number;
  lastAuthor: string | null;
  lastMessageAt: string | null;
  lastExcerpt: string;
  pendingFor: "agent" | "user" | null;
}

function classifyParticipant(thread: ThreadRecord): "agent" | "user" | null {
  const lastMessage = thread.messages.at(-1);
  if (!lastMessage) {
    return null;
  }

  if (lastMessage.authorType === "human") {
    return "user";
  }

  if (lastMessage.authorType === "codex" || lastMessage.authorType === "claude") {
    return "agent";
  }

  if (lastMessage.author === "user") {
    return "user";
  }

  if (lastMessage.author === "agent") {
    return "agent";
  }

  return null;
}

function getPendingFor(thread: ThreadRecord): "agent" | "user" | null {
  if (thread.status !== "open") {
    return null;
  }

  const participant = classifyParticipant(thread);
  if (participant === "agent") {
    return "user";
  }
  if (participant === "user") {
    return "agent";
  }
  return null;
}

function summarizeThread(thread: ThreadRecord): ThreadListItem {
  const lastMessage = thread.messages.at(-1) ?? null;
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    freshness: thread.freshness,
    type: thread.type,
    filePath: thread.filePath,
    startLine: thread.startLine,
    endLine: thread.endLine,
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
    lastAuthor: lastMessage?.author ?? null,
    lastMessageAt: lastMessage?.createdAt ?? null,
    lastExcerpt: lastMessage?.body ?? "",
    pendingFor: getPendingFor(thread)
  };
}

function formatLocation(thread: ThreadListItem): string {
  if (!thread.filePath) {
    return "project";
  }
  if (thread.startLine && thread.endLine) {
    return `${thread.filePath}:${thread.startLine}-${thread.endLine}`;
  }
  return thread.filePath;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function printThreadList(items: ThreadListItem[]): void {
  if (items.length === 0) {
    process.stdout.write("No threads.\n");
    return;
  }

  for (const item of items) {
    const pendingText = item.pendingFor ? `pending:${item.pendingFor}` : "pending:none";
    const excerpt = item.lastExcerpt ? truncate(compactText(item.lastExcerpt), 100) : "";
    const lastAuthor = item.lastAuthor ?? "unknown";
    process.stdout.write(
      `${item.id}  ${item.title}\n` +
        `${formatLocation(item)} · ${item.type} · ${item.status} · ${item.freshness} · ${pendingText} · last:${lastAuthor} · ${item.messageCount} msg\n`
    );
    if (excerpt) {
      process.stdout.write(`${excerpt}\n`);
    }
    process.stdout.write("\n");
  }
}

export async function runThreadList(input: ThreadListInput): Promise<void> {
  await withConnection(input.cwd, async ({ connection, projectRoot }) => {
    const filePath = input.file ? normalizeProjectPath(projectRoot, input.file) : undefined;
    const threads = await listThreads(connection, {
      limit: input.limit,
      status: input.status,
      freshness: input.freshness,
      type: input.type,
      filePath,
      pendingFor: input.pendingFor
    });
    const items = threads.map(summarizeThread);

    if (input.json) {
      printJson(items);
      return;
    }

    printThreadList(items);
  });
}
