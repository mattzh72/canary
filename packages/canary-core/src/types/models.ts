export type AgentKind = "codex" | "claude";

export type SessionStatus = "running" | "completed" | "failed" | "aborted";

export type EventKind = "session_status" | "file_diff" | "conversation_item" | "warning";

export type EventSource = "canary" | "watcher" | "observer" | "canaryctl";

export type ThreadType = "decision" | "question" | "risk" | "scope_change";
export type LineSide = "old" | "new";
export type ArtifactFreshness = "active" | "outdated";

export type ThreadStatus = "open" | "resolved";
export type TodoKind =
  | "thread_reply_needed"
  | "thread_waiting_on_user"
  | "thread_anchor_outdated"
  | "brief_outdated";

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
  status: ThreadStatus;
  freshness: ArtifactFreshness;
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
  freshness: ArtifactFreshness;
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
  kind: "thread" | "file_brief";
  id: string;
  title: string;
  excerpt: string;
  filePath: string | null;
  updatedAt: string;
}

export interface TodoRecord {
  kind: TodoKind;
  artifactKind: "thread" | "file_brief";
  artifactId: string;
  filePath: string | null;
  title: string;
  status: ThreadStatus | null;
  freshness: ArtifactFreshness;
  pendingFor: "agent" | "user" | null;
  updatedAt: string;
}

export interface ProjectOverview {
  session: SessionRecord | null;
  changedFiles: ChangedFileSummary[];
  threads: ThreadRecord[];
  fileBriefs: FileBriefRecord[];
  recentEvents: EventRecord[];
}
