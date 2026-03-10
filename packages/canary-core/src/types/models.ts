export type AgentKind = "codex" | "claude";

export type SessionStatus = "running" | "completed" | "failed" | "aborted";

export type EventKind = "session_status" | "file_diff" | "conversation_item" | "warning";

export type EventSource = "canary" | "watcher" | "observer" | "canaryctl";

export type ReviewMarkCategory =
  | "design_decision"
  | "assumption"
  | "tradeoff"
  | "risk"
  | "needs_confirmation"
  | "follow_up";

export type ReviewMarkSeverity = "low" | "medium" | "high";
export type ThreadType = "decision" | "assumption" | "risk" | "scope_extension";
export type ThreadSeverity = "low" | "medium" | "high";

export type AnnotationStatus = "current" | "outdated" | "superseded" | "resolved";
export type LineSide = "old" | "new";

export type NoteKind = "rationale" | "context" | "explanation";

export type ThreadStatus = "open" | "resolved";

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface SessionRecord {
  id: string;
  projectRoot: string;
  agentKind: AgentKind;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  metadata: JsonObject;
}

export interface EventRecord {
  id: number;
  sessionId: string;
  ts: string;
  kind: EventKind;
  source: EventSource;
  payload: JsonObject;
}

export interface FileDiffPayload {
  filePath: string;
  eventType: "add" | "change" | "unlink";
  patch: string;
  added: number;
  removed: number;
}

export interface ReviewMarkRecord {
  id: string;
  projectRoot: string;
  sessionId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  lineSide: LineSide | null;
  title: string;
  category: ReviewMarkCategory;
  severity: ReviewMarkSeverity;
  status: AnnotationStatus;
  reviewReason: string;
  rationale: string | null;
  anchor: JsonObject;
  source: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface NoteRecord {
  id: string;
  projectRoot: string;
  sessionId: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  lineSide: LineSide | null;
  title: string;
  body: string;
  kind: NoteKind;
  status: AnnotationStatus;
  anchor: JsonObject;
  source: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadMessageRecord {
  id: string;
  threadId: string;
  body: string;
  source: string;
  author: string;
  createdAt: string;
}

export interface ThreadRecord {
  id: string;
  projectRoot: string;
  sessionId: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  lineSide: LineSide | null;
  title: string;
  type: ThreadType;
  severity: ThreadSeverity;
  status: ThreadStatus;
  anchor: JsonObject;
  source: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  messages: ThreadMessageRecord[];
}

export interface FileBriefRecord {
  id: string;
  projectRoot: string;
  filePath: string;
  summary: string;
  details: string | null;
  source: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChangedFileSummary {
  filePath: string;
  eventType: "add" | "change" | "unlink";
  patch: string;
  added: number;
  removed: number;
  lastUpdatedAt: string;
}

export interface SearchResult {
  kind: "mark" | "note" | "thread" | "file_brief";
  id: string;
  title: string;
  excerpt: string;
  filePath: string | null;
  updatedAt: string;
}

export interface ProjectOverview {
  session: SessionRecord | null;
  changedFiles: ChangedFileSummary[];
  marks: ReviewMarkRecord[];
  notes: NoteRecord[];
  threads: ThreadRecord[];
  fileBriefs: FileBriefRecord[];
  recentEvents: EventRecord[];
}
