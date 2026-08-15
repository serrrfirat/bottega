-- Bottega store schema (v1). Idempotent: every object is IF NOT EXISTS,
-- so re-running this file (e.g. on every boot, server and executor) is a no-op.

CREATE TABLE IF NOT EXISTS spaces (
  id          TEXT PRIMARY KEY,          -- "slack:C0123/thread" or "slack:C0123"
  platform    TEXT NOT NULL,             -- 'slack' | 'telegram'
  channel_id  TEXT NOT NULL,
  name        TEXT,
  policy_json TEXT NOT NULL DEFAULT '{}',-- space policy overlay (org config is the floor)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,         -- "wi_<nanoid>"
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  requester    TEXT NOT NULL,            -- principal (slack user id)
  description  TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','claimed','working','review','done','blocked','aborted')),
  approvals    TEXT NOT NULL DEFAULT '[]',-- JSON array of {approver, at}
  evidence     TEXT NOT NULL DEFAULT '[]',-- JSON array of {kind, url, at}
  result       TEXT,                     -- JSON: {pr_url, summary}
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_items_queue ON work_items(space_id, state);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  space_id   TEXT,
  actor      TEXT NOT NULL,              -- principal or "agent:work:wi_x"
  event_type TEXT NOT NULL,              -- message.in, tool_call, policy.decision,
                                         -- approval.requested/resolved, work_item.transition, ...
  payload    TEXT NOT NULL               -- JSON, secrets redacted before write
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);

-- Audit is append-only: the store exposes no update/delete helpers, and
-- these triggers make direct UPDATE/DELETE fail on any connection.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only: UPDATE not allowed');
END;

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN
  SELECT RAISE(ABORT, 'audit is append-only: DELETE not allowed');
END;
