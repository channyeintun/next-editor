CREATE TABLE IF NOT EXISTS runtime_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS runtime_sessions_active_user
  ON runtime_sessions (user_id, ended_at);

CREATE TABLE IF NOT EXISTS runtime_daily_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
