import type { Generated } from "kysely";

export interface SessionsTable {
  id: string;
  project_root: string;
  agent_kind: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  metadata_json: string;
}

export interface EventsTable {
  id: Generated<number>;
  session_id: string;
  ts: string;
  kind: string;
  source: string;
  payload_json: string;
}

export interface ThreadsTable {
  id: string;
  project_root: string;
  session_id: string | null;
  file_path: string | null;
  start_line: number | null;
  end_line: number | null;
  line_side: string | null;
  title: string;
  type: string;
  status: string;
  freshness: string;
  anchor_json: string;
  source: string;
  author: string;
  created_at: string;
  updated_at: string;
}

export interface ThreadMessagesTable {
  id: string;
  thread_id: string;
  body: string;
  source: string;
  author: string;
  created_at: string;
}

export interface FileBriefsTable {
  id: string;
  project_root: string;
  file_path: string;
  summary: string;
  details: string | null;
  freshness: string;
  source: string;
  author: string;
  created_at: string;
  updated_at: string;
}

export interface MigrationsTable {
  id: string;
  applied_at: string;
}

export interface CanaryDatabase {
  sessions: SessionsTable;
  events: EventsTable;
  threads: ThreadsTable;
  thread_messages: ThreadMessagesTable;
  file_briefs: FileBriefsTable;
  migrations: MigrationsTable;
}
