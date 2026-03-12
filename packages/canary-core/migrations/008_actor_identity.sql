CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  project_root TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_svg TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_actors_project_kind
  ON actors (project_root, kind, created_at DESC);

ALTER TABLE sessions ADD COLUMN actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN session_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_token
  ON sessions (session_token)
  WHERE session_token IS NOT NULL;

ALTER TABLE threads ADD COLUMN actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL;
ALTER TABLE thread_messages ADD COLUMN actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL;
ALTER TABLE file_briefs ADD COLUMN actor_id TEXT REFERENCES actors(id) ON DELETE SET NULL;
