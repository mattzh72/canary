import fs from "node:fs";
import path from "node:path";
import type { Selectable } from "kysely";
import type { CanaryConnection } from "../db/connection.js";
import { createId } from "../db/ids.js";
import { parseJsonObject, stringifyJson } from "../db/json.js";
import type {
  EventsTable,
  FileBriefsTable,
  SessionsTable,
  ThreadsTable,
  ThreadMessagesTable
} from "../types/database.js";
import type {
  ActorKind,
  ArtifactFreshness,
  ChangedFileSummary,
  EventKind,
  EventRecord,
  EventSource,
  FileBriefRecord,
  JsonObject,
  LineSide,
  ProjectOverview,
  SearchResult,
  SessionRecord,
  SessionStatus,
  TodoRecord,
  ThreadMessageRecord,
  ThreadRecord,
  ThreadType,
  ThreadStatus
} from "../types/models.js";

interface CreateSessionInput {
  agentKind: SessionRecord["agentKind"];
  actorId?: string | null;
  sessionToken?: string | null;
  metadata?: JsonObject;
}

interface AppendEventInput {
  sessionId: string;
  kind: EventKind;
  source: EventSource;
  payload: JsonObject;
  ts?: string;
}

interface AnchorTarget {
  filePath: string | null;
  startLine?: number | null;
  endLine?: number | null;
  lineSide?: LineSide | null;
  anchor?: JsonObject;
}

interface CreateThreadInput extends AnchorTarget {
  sessionId?: string | null;
  authorId?: string | null;
  title: string;
  body: string;
  type: ThreadType;
  status?: ThreadStatus;
  source?: string;
  author?: string;
  authorType?: ActorKind | null;
  authorAvatarSvg?: string | null;
}

interface AddThreadMessageInput {
  threadId: string;
  authorId?: string | null;
  body: string;
  source?: string;
  author?: string;
  authorType?: ActorKind | null;
  authorAvatarSvg?: string | null;
}

interface UpdateThreadStatusInput {
  threadId: string;
  status: ThreadStatus;
}

interface ListThreadsInput {
  limit?: number;
  status?: ThreadStatus | "all";
  freshness?: ArtifactFreshness | "all";
  type?: ThreadType;
  filePath?: string;
  pendingFor?: "agent" | "user";
}

interface ListFileBriefsInput {
  limit?: number;
  updatedSince?: string;
  freshness?: ArtifactFreshness | "all";
  filePath?: string;
}

interface ListTodosInput {
  limit?: number;
  filePath?: string;
}

interface UpsertFileBriefInput {
  filePath: string;
  summary: string;
  details?: string | null;
  authorId?: string | null;
  source?: string;
  author?: string;
  authorType?: ActorKind | null;
  authorAvatarSvg?: string | null;
}

interface ActorLookup {
  id: string;
  kind: ActorKind;
  displayName: string;
  avatarSvg: string;
}

interface ReconcileFileChangeInput {
  filePath: string;
  oldContent: string;
  newContent: string;
  patch: string;
}

interface ParsedPatchHunk {
  oldStart: number;
  oldCount: number;
  oldEnd: number;
  newStart: number;
  newCount: number;
  newEnd: number;
  oldToNew: Map<number, number>;
}

function mapSession(row: Selectable<SessionsTable>): SessionRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    agentKind: row.agent_kind as SessionRecord["agentKind"],
    status: row.status as SessionStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: parseJsonObject(row.metadata_json),
    actorId: row.actor_id ?? null,
    actorName: null,
    actorAvatarSvg: null
  };
}

function mapEvent(row: Selectable<EventsTable>): EventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ts: row.ts,
    kind: row.kind as EventKind,
    source: row.source as EventSource,
    payload: parseJsonObject(row.payload_json)
  };
}

function normalizeThreadType(type: string): ThreadType {
  if (type === "assumption") {
    return "question";
  }
  if (type === "scope_extension") {
    return "scope_change";
  }
  return type as ThreadType;
}

function mapThread(
  row: Selectable<ThreadsTable>,
  messages: ThreadMessageRecord[],
  actor?: ActorLookup | null
): ThreadRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    sessionId: row.session_id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    lineSide: (row.line_side as LineSide | null) ?? null,
    title: row.title,
    type: normalizeThreadType(row.type),
    status: row.status as ThreadStatus,
    freshness: (row.freshness as ArtifactFreshness | null) ?? "active",
    anchor: parseJsonObject(row.anchor_json),
    source: row.source,
    author: row.author,
    authorId: row.actor_id ?? actor?.id ?? null,
    authorType: actor?.kind ?? null,
    authorAvatarSvg: actor?.avatarSvg ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages
  };
}

function mapThreadMessage(
  row: Selectable<ThreadMessagesTable>,
  actor?: ActorLookup | null
): ThreadMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    source: row.source,
    author: row.author,
    authorId: row.actor_id ?? actor?.id ?? null,
    authorType: actor?.kind ?? null,
    authorAvatarSvg: actor?.avatarSvg ?? null,
    createdAt: row.created_at
  };
}

function mapFileBrief(
  row: Selectable<FileBriefsTable>,
  actor?: ActorLookup | null
): FileBriefRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    filePath: row.file_path,
    summary: row.summary,
    details: row.details,
    freshness: (row.freshness as ArtifactFreshness | null) ?? "active",
    source: row.source,
    author: row.author,
    authorId: row.actor_id ?? actor?.id ?? null,
    authorType: actor?.kind ?? null,
    authorAvatarSvg: actor?.avatarSvg ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function classifyParticipant(authorType: ActorKind | null, author: string): "agent" | "user" | null {
  if (authorType === "human") {
    return "user";
  }
  if (authorType === "codex" || authorType === "claude") {
    return "agent";
  }
  if (author === "user") {
    return "user";
  }
  if (author === "agent") {
    return "agent";
  }
  return null;
}

function getPendingFor(thread: ThreadRecord): "agent" | "user" | null {
  if (thread.status !== "open") {
    return null;
  }

  const lastMessage = thread.messages.at(-1);
  if (!lastMessage) {
    return null;
  }
  const participant = classifyParticipant(lastMessage.authorType, lastMessage.author);
  if (participant === "agent") {
    return "user";
  }
  if (participant === "user") {
    return "agent";
  }
  return null;
}

async function loadActorMap(
  connection: CanaryConnection,
  actorIds: Iterable<string | null | undefined>
): Promise<Map<string, ActorLookup>> {
  const ids = [...new Set([...actorIds].filter((value): value is string => typeof value === "string"))];
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await connection.db
    .selectFrom("actors")
    .selectAll()
    .where("id", "in", ids)
    .execute();

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: row.kind as ActorKind,
        displayName: row.display_name,
        avatarSvg: row.avatar_svg
      }
    ])
  );
}

function createAnchorPayload(target: AnchorTarget): JsonObject {
  const anchor = target.anchor ?? {};
  if (target.filePath) {
    anchor.filePath = target.filePath;
  }
  if (typeof target.startLine === "number") {
    anchor.startLine = target.startLine;
  }
  if (typeof target.endLine === "number") {
    anchor.endLine = target.endLine;
  }
  if (target.lineSide) {
    anchor.lineSide = target.lineSide;
  }
  return anchor;
}

function getContentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function getLinesInRange(content: string, startLine: number, endLine: number): string[] | null {
  const lines = getContentLines(content);
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    return null;
  }
  return lines.slice(startLine - 1, endLine);
}

function readThreadAnchorText(
  projectRoot: string,
  filePath: string,
  startLine: number,
  endLine: number
): string[] | null {
  try {
    const absolutePath = path.join(projectRoot, filePath);
    const content = fs.readFileSync(absolutePath, "utf8");
    return getLinesInRange(content, startLine, endLine);
  } catch {
    return null;
  }
}

function parseUnifiedPatch(patch: string): ParsedPatchHunk[] {
  const hunks: ParsedPatchHunk[] = [];
  const lines = patch.split("\n");
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const match = rawLine.match(header);
    if (!match?.[1] || !match[3]) {
      continue;
    }

    const oldStart = Number.parseInt(match[1], 10);
    const oldCount = Number.parseInt(match[2] ?? "1", 10);
    const newStart = Number.parseInt(match[3], 10);
    const newCount = Number.parseInt(match[4] ?? "1", 10);
    const oldToNew = new Map<number, number>();
    let oldLine = oldStart;
    let newLine = newStart;

    while (index + 1 < lines.length) {
      const nextLine = lines[index + 1] ?? "";
      if (header.test(nextLine)) {
        break;
      }

      index += 1;

      if (nextLine.startsWith(" ")) {
        oldToNew.set(oldLine, newLine);
        oldLine += 1;
        newLine += 1;
        continue;
      }

      if (nextLine.startsWith("-")) {
        oldLine += 1;
        continue;
      }

      if (nextLine.startsWith("+")) {
        newLine += 1;
        continue;
      }

      if (nextLine.startsWith("\\")) {
        continue;
      }

      break;
    }

    hunks.push({
      oldStart,
      oldCount,
      oldEnd: oldCount === 0 ? oldStart - 1 : oldStart + oldCount - 1,
      newStart,
      newCount,
      newEnd: newCount === 0 ? newStart - 1 : newStart + newCount - 1,
      oldToNew
    });
  }

  return hunks;
}

function remapThreadSpan(
  thread: ThreadRecord,
  oldContent: string,
  newContent: string,
  patch: string
): {
  startLine: number | null;
  endLine: number | null;
  lineSide: LineSide | null;
  freshness: ArtifactFreshness;
  anchor: JsonObject;
} {
  if (thread.startLine === null || thread.endLine === null) {
    return {
      startLine: thread.startLine,
      endLine: thread.endLine,
      lineSide: thread.lineSide,
      freshness: thread.freshness,
      anchor: thread.anchor
    };
  }

  if (thread.lineSide === "old") {
    return {
      startLine: thread.startLine,
      endLine: thread.endLine,
      lineSide: thread.lineSide,
      freshness: "outdated",
      anchor: thread.anchor
    };
  }

  const oldAnchorLines = getLinesInRange(oldContent, thread.startLine, thread.endLine);
  if (!oldAnchorLines) {
    return {
      startLine: thread.startLine,
      endLine: thread.endLine,
      lineSide: thread.lineSide,
      freshness: "outdated",
      anchor: thread.anchor
    };
  }

  const hunks = parseUnifiedPatch(patch);
  let delta = 0;
  let overlapsAnchor = false;

  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      if (hunk.oldStart <= thread.startLine) {
        delta += hunk.newCount;
      } else if (hunk.oldStart <= thread.endLine) {
        overlapsAnchor = true;
      }
      continue;
    }

    if (hunk.oldEnd < thread.startLine) {
      delta += hunk.newCount - hunk.oldCount;
      continue;
    }

    if (hunk.oldStart > thread.endLine) {
      continue;
    }

    overlapsAnchor = true;
  }

  if (!overlapsAnchor) {
    const nextStartLine = thread.startLine + delta;
    const nextEndLine = thread.endLine + delta;
    const anchor = {
      ...thread.anchor,
      startLine: nextStartLine,
      endLine: nextEndLine,
      lineSide: thread.lineSide ?? "new"
    };
    return {
      startLine: nextStartLine,
      endLine: nextEndLine,
      lineSide: thread.lineSide ?? "new",
      freshness: "active",
      anchor
    };
  }

  const oldToNew = new Map<number, number>();
  for (const hunk of hunks) {
    for (const [oldLine, newLine] of hunk.oldToNew.entries()) {
      oldToNew.set(oldLine, newLine);
    }
  }

  const mappedLines: number[] = [];
  for (let line = thread.startLine; line <= thread.endLine; line += 1) {
    const mapped = oldToNew.get(line);
    if (typeof mapped !== "number") {
      return {
        startLine: thread.startLine,
        endLine: thread.endLine,
        lineSide: thread.lineSide,
        freshness: "outdated",
        anchor: thread.anchor
      };
    }
    mappedLines.push(mapped);
  }

  for (let index = 1; index < mappedLines.length; index += 1) {
    if (mappedLines[index] !== mappedLines[index - 1]! + 1) {
      return {
        startLine: thread.startLine,
        endLine: thread.endLine,
        lineSide: thread.lineSide,
        freshness: "outdated",
        anchor: thread.anchor
      };
    }
  }

  const nextStartLine = mappedLines[0] ?? thread.startLine;
  const nextEndLine = mappedLines.at(-1) ?? thread.endLine;
  const newAnchorLines = getLinesInRange(newContent, nextStartLine, nextEndLine);
  if (!newAnchorLines || newAnchorLines.join("\n") !== oldAnchorLines.join("\n")) {
    return {
      startLine: thread.startLine,
      endLine: thread.endLine,
      lineSide: thread.lineSide,
      freshness: "outdated",
      anchor: thread.anchor
    };
  }

  const anchor = {
    ...thread.anchor,
    startLine: nextStartLine,
    endLine: nextEndLine,
    lineSide: thread.lineSide ?? "new"
  };
  return {
    startLine: nextStartLine,
    endLine: nextEndLine,
    lineSide: thread.lineSide ?? "new",
    freshness: "active",
    anchor
  };
}

export async function createSession(
  connection: CanaryConnection,
  input: CreateSessionInput
): Promise<SessionRecord> {
  const id = createId("sess");
  const startedAt = new Date().toISOString();

  await connection.db
    .insertInto("sessions")
    .values({
      id,
      project_root: connection.projectRoot,
      agent_kind: input.agentKind,
      actor_id: input.actorId ?? null,
      session_token: input.sessionToken ?? null,
      status: "running",
      started_at: startedAt,
      ended_at: null,
      metadata_json: stringifyJson(input.metadata ?? {})
    })
    .execute();

  return {
    id,
    projectRoot: connection.projectRoot,
    agentKind: input.agentKind,
    status: "running",
    startedAt,
    endedAt: null,
    metadata: input.metadata ?? {},
    actorId: input.actorId ?? null,
    actorName: null,
    actorAvatarSvg: null
  };
}

export async function finishSession(
  connection: CanaryConnection,
  sessionId: string,
  status: SessionStatus
): Promise<void> {
  await connection.db
    .updateTable("sessions")
    .set({
      status,
      ended_at: new Date().toISOString()
    })
    .where("id", "=", sessionId)
    .execute();
}

export async function getLatestSession(
  connection: CanaryConnection
): Promise<SessionRecord | null> {
  const row = await connection.db
    .selectFrom("sessions")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  return row ? mapSession(row) : null;
}

export async function appendEvent(
  connection: CanaryConnection,
  input: AppendEventInput
): Promise<EventRecord> {
  const ts = input.ts ?? new Date().toISOString();

  const row = await connection.db
    .insertInto("events")
    .values({
      session_id: input.sessionId,
      ts,
      kind: input.kind,
      source: input.source,
      payload_json: stringifyJson(input.payload)
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapEvent(row);
}

export async function listRecentEvents(
  connection: CanaryConnection,
  sessionId: string,
  limit = 40
): Promise<EventRecord[]> {
  const rows = await connection.db
    .selectFrom("events")
    .selectAll()
    .where("session_id", "=", sessionId)
    .orderBy("id", "desc")
    .limit(limit)
    .execute();

  return rows.reverse().map(mapEvent);
}

export async function createThread(
  connection: CanaryConnection,
  input: CreateThreadInput
): Promise<ThreadRecord> {
  const id = createId("thread");
  const messageId = createId("msg");
  const now = new Date().toISOString();
  const capturedAnchorLines =
    input.filePath && typeof input.startLine === "number" && typeof input.endLine === "number"
      ? readThreadAnchorText(connection.projectRoot, input.filePath, input.startLine, input.endLine)
      : null;
  const anchor = createAnchorPayload({
    ...input,
    anchor: capturedAnchorLines
      ? {
          ...input.anchor,
          text: capturedAnchorLines.join("\n")
        }
      : input.anchor
  });

  await connection.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("threads")
      .values({
        id,
        project_root: connection.projectRoot,
        session_id: input.sessionId ?? null,
        actor_id: input.authorId ?? null,
        file_path: input.filePath ?? null,
        start_line: input.startLine ?? null,
        end_line: input.endLine ?? null,
        line_side: input.lineSide ?? null,
        title: input.title,
        type: input.type,
        status: input.status ?? "open",
        freshness: "active",
        anchor_json: stringifyJson(anchor),
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
        created_at: now,
        updated_at: now
      })
      .execute();

    await trx
      .insertInto("thread_messages")
      .values({
        id: messageId,
        thread_id: id,
        actor_id: input.authorId ?? null,
        body: input.body,
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
        created_at: now
      })
      .execute();
  });

  return {
    id,
    projectRoot: connection.projectRoot,
    sessionId: input.sessionId ?? null,
    filePath: input.filePath ?? null,
    startLine: input.startLine ?? null,
    endLine: input.endLine ?? null,
    lineSide: input.lineSide ?? null,
    title: input.title,
    type: input.type,
    status: input.status ?? "open",
    freshness: "active",
    anchor,
    source: input.source ?? "canaryctl",
    author: input.author ?? "agent",
    authorId: input.authorId ?? null,
    authorType: input.authorType ?? null,
    authorAvatarSvg: input.authorAvatarSvg ?? null,
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: messageId,
        threadId: id,
        body: input.body,
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
        authorId: input.authorId ?? null,
        authorType: input.authorType ?? null,
        authorAvatarSvg: input.authorAvatarSvg ?? null,
        createdAt: now
      }
    ]
  };
}

export async function addThreadMessage(
  connection: CanaryConnection,
  input: AddThreadMessageInput
): Promise<ThreadMessageRecord> {
  const id = createId("msg");
  const now = new Date().toISOString();

  await connection.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("thread_messages")
      .values({
        id,
        thread_id: input.threadId,
        actor_id: input.authorId ?? null,
        body: input.body,
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
        created_at: now
      })
      .execute();

    await trx
      .updateTable("threads")
      .set({ updated_at: now })
      .where("id", "=", input.threadId)
      .execute();
  });

  return {
    id,
    threadId: input.threadId,
    body: input.body,
    source: input.source ?? "canaryctl",
    author: input.author ?? "agent",
    authorId: input.authorId ?? null,
    authorType: input.authorType ?? null,
    authorAvatarSvg: input.authorAvatarSvg ?? null,
    createdAt: now
  };
}

export async function updateThreadStatus(
  connection: CanaryConnection,
  input: UpdateThreadStatusInput
): Promise<ThreadRecord> {
  const now = new Date().toISOString();
  const row = await connection.db
    .updateTable("threads")
    .set({
      status: input.status,
      updated_at: now
    })
    .where("project_root", "=", connection.projectRoot)
    .where("id", "=", input.threadId)
    .returningAll()
    .executeTakeFirstOrThrow();

  const messages = await connection.db
    .selectFrom("thread_messages")
    .selectAll()
    .where("thread_id", "=", input.threadId)
    .orderBy("created_at", "asc")
    .execute();

  const actorMap = await loadActorMap(connection, [
    row.actor_id,
    ...messages.map((message) => message.actor_id)
  ]);

  return mapThread(
    row,
    messages.map((message) => mapThreadMessage(message, actorMap.get(message.actor_id ?? ""))),
    actorMap.get(row.actor_id ?? "")
  );
}

export async function listThreads(
  connection: CanaryConnection,
  input: number | ListThreadsInput = 30
): Promise<ThreadRecord[]> {
  const options = typeof input === "number" ? { limit: input } : input;
  const limit = options.limit ?? 30;
  let query = connection.db
    .selectFrom("threads")
    .selectAll()
    .where("project_root", "=", connection.projectRoot);

  if (options.status && options.status !== "all") {
    query = query.where("status", "=", options.status);
  }
  if (options.freshness && options.freshness !== "all") {
    query = query.where("freshness", "=", options.freshness);
  }
  if (options.type) {
    query = query.where("type", "=", options.type);
  }
  if (options.filePath) {
    query = query.where("file_path", "=", options.filePath);
  }

  const rows = await query.orderBy("updated_at", "desc").execute();

  const messages = await connection.db
    .selectFrom("thread_messages")
    .selectAll()
    .where(
      "thread_id",
      "in",
      rows.length > 0 ? rows.map((row) => row.id) : [""]
    )
    .orderBy("created_at", "asc")
    .execute();

  const actorMap = await loadActorMap(connection, [
    ...rows.map((row) => row.actor_id),
    ...messages.map((message) => message.actor_id)
  ]);

  const byThread = new Map<string, ThreadMessageRecord[]>();
  for (const message of messages.map((row) => mapThreadMessage(row, actorMap.get(row.actor_id ?? "")))) {
    const bucket = byThread.get(message.threadId) ?? [];
    bucket.push(message);
    byThread.set(message.threadId, bucket);
  }

  const threads = rows.map((row) =>
    mapThread(row, byThread.get(row.id) ?? [], actorMap.get(row.actor_id ?? ""))
  );
  const filteredThreads = options.pendingFor
    ? threads.filter((thread) => {
        if (thread.status !== "open") {
          return false;
        }

        const lastMessage = thread.messages.at(-1);
        if (!lastMessage) {
          return false;
        }

        const participant = classifyParticipant(lastMessage.authorType, lastMessage.author);
        return options.pendingFor === "agent" ? participant === "user" : participant === "agent";
      })
    : threads;

  return filteredThreads.slice(0, limit);
}

export async function upsertFileBrief(
  connection: CanaryConnection,
  input: UpsertFileBriefInput
): Promise<FileBriefRecord> {
  const existing = await connection.db
    .selectFrom("file_briefs")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .where("file_path", "=", input.filePath)
    .executeTakeFirst();

  const now = new Date().toISOString();
  const id = existing?.id ?? createId("brief");
  const briefActor =
    input.authorType
      ? {
          id: input.authorId ?? "",
          kind: input.authorType,
          displayName: input.author ?? "agent",
          avatarSvg: input.authorAvatarSvg ?? ""
        }
      : null;

  if (existing) {
    const updated = await connection.db
      .updateTable("file_briefs")
      .set({
        summary: input.summary,
        details: input.details ?? null,
        freshness: "active",
        actor_id: input.authorId ?? null,
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
        updated_at: now
      })
      .where("id", "=", existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapFileBrief(updated, briefActor);
  }

  const inserted = await connection.db
    .insertInto("file_briefs")
    .values({
      id,
      project_root: connection.projectRoot,
      actor_id: input.authorId ?? null,
      file_path: input.filePath,
      summary: input.summary,
      details: input.details ?? null,
      freshness: "active",
      source: input.source ?? "canaryctl",
      author: input.author ?? "agent",
      created_at: now,
      updated_at: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapFileBrief(inserted, briefActor);
}

export async function listFileBriefs(
  connection: CanaryConnection,
  input: number | ListFileBriefsInput = 50
): Promise<FileBriefRecord[]> {
  const options = typeof input === "number" ? { limit: input } : input;
  const limit = options.limit ?? 50;
  let query = connection.db
    .selectFrom("file_briefs")
    .selectAll()
    .where("project_root", "=", connection.projectRoot);

  if (options.updatedSince) {
    query = query.where("updated_at", ">=", options.updatedSince);
  }
  if (options.freshness && options.freshness !== "all") {
    query = query.where("freshness", "=", options.freshness);
  }
  if (options.filePath) {
    query = query.where("file_path", "=", options.filePath);
  }

  const rows = await query
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

  const actorMap = await loadActorMap(connection, rows.map((row) => row.actor_id));
  return rows.map((row) => mapFileBrief(row, actorMap.get(row.actor_id ?? "")));
}

export async function reconcileArtifactsForFileChange(
  connection: CanaryConnection,
  input: ReconcileFileChangeInput
): Promise<void> {
  const now = new Date().toISOString();
  const threads = await listThreads(connection, {
    status: "all",
    freshness: "active",
    filePath: input.filePath,
    limit: 500
  });
  const briefs = await listFileBriefs(connection, {
    filePath: input.filePath,
    freshness: "active",
    limit: 50
  });

  if (threads.length === 0 && briefs.length === 0) {
    return;
  }

  await connection.db.transaction().execute(async (trx) => {
    for (const thread of threads) {
      const next = remapThreadSpan(thread, input.oldContent, input.newContent, input.patch);
      if (
        next.freshness === thread.freshness &&
        next.startLine === thread.startLine &&
        next.endLine === thread.endLine &&
        next.lineSide === thread.lineSide
      ) {
        continue;
      }

      await trx
        .updateTable("threads")
        .set({
          start_line: next.startLine,
          end_line: next.endLine,
          line_side: next.lineSide,
          freshness: next.freshness,
          anchor_json: stringifyJson(next.anchor),
          updated_at: now
        })
        .where("id", "=", thread.id)
        .execute();
    }

    if (briefs.length > 0) {
      await trx
        .updateTable("file_briefs")
        .set({
          freshness: "outdated",
          updated_at: now
        })
        .where("project_root", "=", connection.projectRoot)
        .where("file_path", "=", input.filePath)
        .where("freshness", "=", "active")
        .execute();
    }
  });
}

export async function listTodos(
  connection: CanaryConnection,
  input: number | ListTodosInput = 50
): Promise<TodoRecord[]> {
  const options = typeof input === "number" ? { limit: input } : input;
  const limit = options.limit ?? 50;
  const [threads, outdatedBriefs] = await Promise.all([
    listThreads(connection, {
      status: "open",
      freshness: "all",
      filePath: options.filePath,
      limit: 500
    }),
    listFileBriefs(connection, {
      freshness: "outdated",
      filePath: options.filePath,
      limit: 200
    })
  ]);

  const items: TodoRecord[] = [];

  for (const thread of threads) {
    const pendingFor = getPendingFor(thread);
    if (thread.freshness === "outdated") {
      items.push({
        kind: "thread_anchor_outdated",
        artifactKind: "thread",
        artifactId: thread.id,
        filePath: thread.filePath,
        title: thread.title,
        status: thread.status,
        freshness: thread.freshness,
        pendingFor,
        updatedAt: thread.updatedAt
      });
      continue;
    }

    if (pendingFor === "agent") {
      items.push({
        kind: "thread_reply_needed",
        artifactKind: "thread",
        artifactId: thread.id,
        filePath: thread.filePath,
        title: thread.title,
        status: thread.status,
        freshness: thread.freshness,
        pendingFor,
        updatedAt: thread.updatedAt
      });
      continue;
    }

    if (pendingFor === "user") {
      items.push({
        kind: "thread_waiting_on_user",
        artifactKind: "thread",
        artifactId: thread.id,
        filePath: thread.filePath,
        title: thread.title,
        status: thread.status,
        freshness: thread.freshness,
        pendingFor,
        updatedAt: thread.updatedAt
      });
    }
  }

  for (const brief of outdatedBriefs) {
    items.push({
      kind: "brief_outdated",
      artifactKind: "file_brief",
      artifactId: brief.id,
      filePath: brief.filePath,
      title: brief.filePath,
      status: null,
      freshness: brief.freshness,
      pendingFor: null,
      updatedAt: brief.updatedAt
    });
  }

  return items
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

export async function searchProject(
  connection: CanaryConnection,
  query: string
): Promise<SearchResult[]> {
  const like = `%${query}%`;

  const [threads, briefs] = await Promise.all([
    connection.db
      .selectFrom("threads")
      .leftJoin("thread_messages", "thread_messages.thread_id", "threads.id")
      .select([
        "threads.id as id",
        "threads.file_path as file_path",
        "threads.title as title",
        "threads.updated_at as updated_at",
        "thread_messages.body as body"
      ])
      .where("threads.project_root", "=", connection.projectRoot)
      .where((eb) =>
        eb.or([
          eb("threads.title", "like", like),
          eb("thread_messages.body", "like", like)
        ])
      )
      .limit(20)
      .execute(),
    connection.db
      .selectFrom("file_briefs")
      .selectAll()
      .where("project_root", "=", connection.projectRoot)
      .where((eb) =>
        eb.or([eb("summary", "like", like), eb("details", "like", like)])
      )
      .limit(20)
      .execute()
  ]);

  return [
    ...threads.map((thread) => ({
      kind: "thread" as const,
      id: thread.id,
      title: thread.title,
      excerpt: thread.body ?? "",
      filePath: thread.file_path,
      updatedAt: thread.updated_at
    })),
    ...briefs.map((brief) => ({
      kind: "file_brief" as const,
      id: brief.id,
      title: brief.file_path,
      excerpt: brief.summary,
      filePath: brief.file_path,
      updatedAt: brief.updated_at
    }))
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getProjectOverview(
  connection: CanaryConnection,
  sessionId?: string
): Promise<ProjectOverview> {
  const session = sessionId
    ? await connection.db
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .executeTakeFirst()
    : await connection.db
        .selectFrom("sessions")
        .selectAll()
        .where("project_root", "=", connection.projectRoot)
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst();

  const selectedSession = session ? mapSession(session) : null;
  const threads = await listThreads(connection, 500);
  const fileBriefs = await listFileBriefs(connection, {
    limit: 500
  });
  const recentEvents = selectedSession
    ? await listRecentEvents(connection, selectedSession.id, 30)
    : [];

  const changedFilesMap = new Map<string, ChangedFileSummary>();
  for (const event of recentEvents) {
    if (event.kind !== "file_diff") {
      continue;
    }

    const payload = event.payload;
    if (
      typeof payload.filePath !== "string" ||
      typeof payload.eventType !== "string" ||
      typeof payload.patch !== "string" ||
      typeof payload.added !== "number" ||
      typeof payload.removed !== "number"
    ) {
      continue;
    }

    changedFilesMap.set(payload.filePath, {
      filePath: payload.filePath,
      eventType: payload.eventType as ChangedFileSummary["eventType"],
      patch: payload.patch,
      added: payload.added,
      removed: payload.removed,
      lastUpdatedAt: event.ts
    });
  }

  const sessionActorMap = selectedSession?.actorId
    ? await loadActorMap(connection, [selectedSession.actorId])
    : new Map<string, ActorLookup>();
  const sessionActor = selectedSession?.actorId
    ? sessionActorMap.get(selectedSession.actorId) ?? null
    : null;

  return {
    session: selectedSession
      ? {
          ...selectedSession,
          actorName: sessionActor?.displayName ?? selectedSession.actorName,
          actorAvatarSvg: sessionActor?.avatarSvg ?? selectedSession.actorAvatarSvg
        }
      : null,
    changedFiles: [...changedFilesMap.values()].sort((left, right) =>
      right.lastUpdatedAt.localeCompare(left.lastUpdatedAt)
    ),
    threads,
    fileBriefs,
    recentEvents
  };
}
