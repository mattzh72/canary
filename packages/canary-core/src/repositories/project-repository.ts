import type { Selectable } from "kysely";
import type { CanaryConnection } from "../db/connection.js";
import { createId } from "../db/ids.js";
import { parseJsonObject, stringifyJson } from "../db/json.js";
import type {
  EventsTable,
  FileBriefsTable,
  NotesTable,
  ReviewMarksTable,
  SessionsTable,
  ThreadsTable,
  ThreadMessagesTable
} from "../types/database.js";
import type {
  ChangedFileSummary,
  EventKind,
  EventRecord,
  EventSource,
  FileBriefRecord,
  JsonObject,
  LineSide,
  NoteKind,
  NoteRecord,
  ProjectOverview,
  ReviewMarkCategory,
  ReviewMarkRecord,
  ReviewMarkSeverity,
  SearchResult,
  SessionRecord,
  SessionStatus,
  ThreadMessageRecord,
  ThreadRecord,
  ThreadSeverity,
  ThreadType,
  ThreadStatus
} from "../types/models.js";

interface CreateSessionInput {
  agentKind: SessionRecord["agentKind"];
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

interface CreateReviewMarkInput extends AnchorTarget {
  sessionId?: string | null;
  title: string;
  category: ReviewMarkCategory;
  severity: ReviewMarkSeverity;
  status?: ReviewMarkRecord["status"];
  reviewReason: string;
  rationale?: string | null;
  source?: string;
  author?: string;
}

interface CreateNoteInput extends AnchorTarget {
  sessionId?: string | null;
  title: string;
  body: string;
  kind: NoteKind;
  status?: NoteRecord["status"];
  source?: string;
  author?: string;
}

interface CreateThreadInput extends AnchorTarget {
  sessionId?: string | null;
  title: string;
  body: string;
  type: ThreadType;
  severity: ThreadSeverity;
  status?: ThreadStatus;
  source?: string;
  author?: string;
}

interface AddThreadMessageInput {
  threadId: string;
  body: string;
  source?: string;
  author?: string;
}

interface UpsertFileBriefInput {
  filePath: string;
  summary: string;
  details?: string | null;
  source?: string;
  author?: string;
}

function mapSession(row: Selectable<SessionsTable>): SessionRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    agentKind: row.agent_kind as SessionRecord["agentKind"],
    status: row.status as SessionStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    metadata: parseJsonObject(row.metadata_json)
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

function mapReviewMark(row: Selectable<ReviewMarksTable>): ReviewMarkRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    sessionId: row.session_id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    lineSide: (row.line_side as LineSide | null) ?? null,
    title: row.title,
    category: row.category as ReviewMarkCategory,
    severity: row.severity as ReviewMarkSeverity,
    status: row.status as ReviewMarkRecord["status"],
    reviewReason: row.review_reason,
    rationale: row.rationale,
    anchor: parseJsonObject(row.anchor_json),
    source: row.source,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapNote(row: Selectable<NotesTable>): NoteRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    sessionId: row.session_id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    lineSide: (row.line_side as LineSide | null) ?? null,
    title: row.title,
    body: row.body,
    kind: row.kind as NoteKind,
    status: row.status as NoteRecord["status"],
    anchor: parseJsonObject(row.anchor_json),
    source: row.source,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapThread(row: Selectable<ThreadsTable>, messages: ThreadMessageRecord[]): ThreadRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    sessionId: row.session_id,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    lineSide: (row.line_side as LineSide | null) ?? null,
    title: row.title,
    type: row.type as ThreadType,
    severity: row.severity as ThreadSeverity,
    status: row.status as ThreadStatus,
    anchor: parseJsonObject(row.anchor_json),
    source: row.source,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages
  };
}

function mapThreadMessage(row: Selectable<ThreadMessagesTable>): ThreadMessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    body: row.body,
    source: row.source,
    author: row.author,
    createdAt: row.created_at
  };
}

function mapFileBrief(row: Selectable<FileBriefsTable>): FileBriefRecord {
  return {
    id: row.id,
    projectRoot: row.project_root,
    filePath: row.file_path,
    summary: row.summary,
    details: row.details,
    source: row.source,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
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
    metadata: input.metadata ?? {}
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

export async function createReviewMark(
  connection: CanaryConnection,
  input: CreateReviewMarkInput
): Promise<ReviewMarkRecord> {
  const id = createId("mark");
  const now = new Date().toISOString();
  const anchor = createAnchorPayload(input);

  const row = await connection.db
    .insertInto("review_marks")
    .values({
      id,
      project_root: connection.projectRoot,
      session_id: input.sessionId ?? null,
      file_path: input.filePath ?? "",
      start_line: input.startLine ?? null,
      end_line: input.endLine ?? null,
      line_side: input.lineSide ?? null,
      title: input.title,
      category: input.category,
      severity: input.severity,
      status: input.status ?? "current",
      review_reason: input.reviewReason,
      rationale: input.rationale ?? null,
      anchor_json: stringifyJson(anchor),
      source: input.source ?? "canaryctl",
      author: input.author ?? "agent",
      created_at: now,
      updated_at: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapReviewMark(row);
}

export async function listReviewMarks(
  connection: CanaryConnection,
  limit = 50
): Promise<ReviewMarkRecord[]> {
  const rows = await connection.db
    .selectFrom("review_marks")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

  return rows.map(mapReviewMark);
}

export async function createNote(
  connection: CanaryConnection,
  input: CreateNoteInput
): Promise<NoteRecord> {
  const id = createId("note");
  const now = new Date().toISOString();
  const anchor = createAnchorPayload(input);

  const row = await connection.db
    .insertInto("notes")
    .values({
      id,
      project_root: connection.projectRoot,
      session_id: input.sessionId ?? null,
      file_path: input.filePath ?? null,
      start_line: input.startLine ?? null,
      end_line: input.endLine ?? null,
      line_side: input.lineSide ?? null,
      title: input.title,
      body: input.body,
      kind: input.kind,
      status: input.status ?? "current",
      anchor_json: stringifyJson(anchor),
      source: input.source ?? "canaryctl",
      author: input.author ?? "agent",
      created_at: now,
      updated_at: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapNote(row);
}

export async function listNotes(
  connection: CanaryConnection,
  limit = 50
): Promise<NoteRecord[]> {
  const rows = await connection.db
    .selectFrom("notes")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

  return rows.map(mapNote);
}

export async function createThread(
  connection: CanaryConnection,
  input: CreateThreadInput
): Promise<ThreadRecord> {
  const id = createId("thread");
  const messageId = createId("msg");
  const now = new Date().toISOString();
  const anchor = createAnchorPayload(input);

  await connection.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("threads")
      .values({
        id,
        project_root: connection.projectRoot,
        session_id: input.sessionId ?? null,
        file_path: input.filePath ?? null,
        start_line: input.startLine ?? null,
        end_line: input.endLine ?? null,
        line_side: input.lineSide ?? null,
        title: input.title,
        type: input.type,
        severity: input.severity,
        status: input.status ?? "open",
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
    severity: input.severity,
    status: input.status ?? "open",
    anchor,
    source: input.source ?? "canaryctl",
    author: input.author ?? "agent",
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        id: messageId,
        threadId: id,
        body: input.body,
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
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
    createdAt: now
  };
}

export async function listThreads(
  connection: CanaryConnection,
  limit = 30
): Promise<ThreadRecord[]> {
  const rows = await connection.db
    .selectFrom("threads")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

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

  const byThread = new Map<string, ThreadMessageRecord[]>();
  for (const message of messages.map(mapThreadMessage)) {
    const bucket = byThread.get(message.threadId) ?? [];
    bucket.push(message);
    byThread.set(message.threadId, bucket);
  }

  return rows.map((row) => mapThread(row, byThread.get(row.id) ?? []));
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

  if (existing) {
    const updated = await connection.db
      .updateTable("file_briefs")
      .set({
        summary: input.summary,
        details: input.details ?? null,
        source: input.source ?? "canaryctl",
        author: input.author ?? "agent",
        updated_at: now
      })
      .where("id", "=", existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapFileBrief(updated);
  }

  const inserted = await connection.db
    .insertInto("file_briefs")
    .values({
      id,
      project_root: connection.projectRoot,
      file_path: input.filePath,
      summary: input.summary,
      details: input.details ?? null,
      source: input.source ?? "canaryctl",
      author: input.author ?? "agent",
      created_at: now,
      updated_at: now
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return mapFileBrief(inserted);
}

export async function listFileBriefs(
  connection: CanaryConnection,
  limit = 50
): Promise<FileBriefRecord[]> {
  const rows = await connection.db
    .selectFrom("file_briefs")
    .selectAll()
    .where("project_root", "=", connection.projectRoot)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();

  return rows.map(mapFileBrief);
}

export async function searchProject(
  connection: CanaryConnection,
  query: string
): Promise<SearchResult[]> {
  const like = `%${query}%`;

  const [marks, notes, threads, briefs] = await Promise.all([
    connection.db
      .selectFrom("review_marks")
      .selectAll()
      .where("project_root", "=", connection.projectRoot)
      .where((eb) =>
        eb.or([
          eb("title", "like", like),
          eb("review_reason", "like", like),
          eb("rationale", "like", like)
        ])
      )
      .limit(20)
      .execute(),
    connection.db
      .selectFrom("notes")
      .selectAll()
      .where("project_root", "=", connection.projectRoot)
      .where((eb) =>
        eb.or([eb("title", "like", like), eb("body", "like", like)])
      )
      .limit(20)
      .execute(),
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
    ...marks.map((mark) => ({
      kind: "mark" as const,
      id: mark.id,
      title: mark.title,
      excerpt: mark.review_reason,
      filePath: mark.file_path,
      updatedAt: mark.updated_at
    })),
    ...notes.map((note) => ({
      kind: "note" as const,
      id: note.id,
      title: note.title,
      excerpt: note.body,
      filePath: note.file_path,
      updatedAt: note.updated_at
    })),
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
  const marks = await listReviewMarks(connection, 20);
  const notes = await listNotes(connection, 20);
  const threads = await listThreads(connection, 12);
  const fileBriefs = await listFileBriefs(connection, 20);
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

  return {
    session: selectedSession,
    changedFiles: [...changedFilesMap.values()].sort((left, right) =>
      right.lastUpdatedAt.localeCompare(left.lastUpdatedAt)
    ),
    marks,
    notes,
    threads,
    fileBriefs,
    recentEvents
  };
}
