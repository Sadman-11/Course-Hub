-- Course Hub schema (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,          -- 'catalog' (gzipped JSON), 'meta' (course titles, names)
  v BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- Google grants. Refresh/access tokens are AES-GCM encrypted with TOKEN_KEY.
CREATE TABLE IF NOT EXISTS accounts (
  account TEXT PRIMARY KEY,    -- 'storage' | 'classroom'
  email TEXT NOT NULL,
  scopes TEXT,
  refresh_enc TEXT NOT NULL,
  access_enc TEXT,
  access_expires INTEGER,
  connected_at TEXT NOT NULL,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,         -- GitHub Actions run id
  status TEXT NOT NULL,        -- ok | partial | failed | dry_run | needs_approval
  trigger TEXT,
  started TEXT NOT NULL,
  finished TEXT,
  counts TEXT,
  plan_hash TEXT,
  commit_sha TEXT,
  run_url TEXT,
  report TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started DESC);

CREATE TABLE IF NOT EXISTS classroom_courses (
  id TEXT PRIMARY KEY,         -- Classroom course id
  name TEXT,
  section TEXT,
  link TEXT,
  target TEXT,                 -- library folder, e.g. 'CSE207/MI'; NULL = not imported
  semester TEXT,               -- e.g. 'Fall-26'; NULL = derive from post date
  auto_publish INTEGER NOT NULL DEFAULT 1,
  mapped_at TEXT,               -- auto-publish only applies to posts created after this
  cursor TEXT,                 -- newest post updateTime already seen
  seen_at TEXT
);

CREATE TABLE IF NOT EXISTS classroom_items (
  key TEXT PRIMARY KEY,        -- '<courseId>:<driveFileId>'
  course_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  title TEXT,
  link TEXT,
  post_kind TEXT,
  post_title TEXT,
  post_link TEXT,
  topic TEXT,
  dest TEXT,                   -- proposed/approved library path
  status TEXT NOT NULL,        -- new | approved | imported | rejected | failed
  drive_id TEXT,
  path TEXT,
  error TEXT,
  created TEXT,
  updated TEXT,
  decided_by TEXT
);
CREATE INDEX IF NOT EXISTS classroom_items_status ON classroom_items (status, updated DESC);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
