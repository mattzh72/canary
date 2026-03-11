CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  agent_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_events_session_id_id
  ON events (session_id, id DESC);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  file_path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  anchor_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_project_file
  ON threads (project_root, file_path, updated_at DESC);

CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread
  ON thread_messages (thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS file_briefs (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  file_path TEXT NOT NULL,
  summary TEXT NOT NULL,
  details TEXT,
  source TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_root, file_path)
);

CREATE INDEX IF NOT EXISTS idx_file_briefs_project_file
  ON file_briefs (project_root, file_path);
