-- Bottega store schema (v1). Idempotent: every object is IF NOT EXISTS,
-- so re-running this file (e.g. on every boot, server and executor) is a no-op.

CREATE TABLE IF NOT EXISTS spaces (
  id          TEXT PRIMARY KEY,          -- "slack:C0123" (DMs, no threads)
  platform    TEXT NOT NULL,             -- 'slack' | 'telegram'
  channel_id  TEXT NOT NULL,
  name        TEXT,
  policy_json TEXT NOT NULL DEFAULT '{}',-- space policy overlay (org config is the floor)
  settings    TEXT NOT NULL DEFAULT '{}',-- per-space model settings JSON (issue #64), see db.ts
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  id          TEXT PRIMARY KEY,          -- "obj_<uuid>"
  space_id    TEXT NOT NULL REFERENCES spaces(id),
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objects_space ON objects(space_id, created_at);

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,         -- "wi_<uuid>"
  space_id     TEXT NOT NULL REFERENCES spaces(id),
  requester    TEXT NOT NULL,            -- principal (slack user id)
  description  TEXT NOT NULL,
  repo         TEXT,                     -- owner/repo the agent derived from the conversation (issue #47);
                                         -- null = not specified (executor blocks and asks the requester)
  pr_url       TEXT,                     -- existing-PR conflict-resolution job shape (issue #186): when set on a
                                         -- git item, the executor rebases the PR's branch onto base_branch,
                                         -- resolves conflicts, and force-with-lease pushes instead of opening a PR
  pr_branch    TEXT,                     -- head branch of the PR to rebase/resolve/push (issue #186)
  base_branch  TEXT,                     -- branch the PR branch is rebased onto; default 'main' (issue #186)
  delivery     TEXT NOT NULL DEFAULT 'git'
               CHECK (delivery IN ('git','extension','chat')), -- delivery-neutral work kind (issue #128)
  model        TEXT,  -- per-task model pin (issue #185): role ref ('fast'|'reasoning') or a resolved available model id
  reasoning_effort TEXT CHECK (reasoning_effort IN ('off','low','medium','high')), -- pinned thinking effort (issue #185)
  state        TEXT NOT NULL DEFAULT 'open'
               CHECK (state IN ('open','claimed','working','review','done','blocked','aborted')),
  approvals    TEXT NOT NULL DEFAULT '[]',-- JSON array of {approver, at}
  evidence     TEXT NOT NULL DEFAULT '[]',-- JSON array of {kind, url, at}
  result       TEXT,                     -- JSON: {pr_url, summary}, {url, summary}, or {summary}
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_items_queue ON work_items(space_id, state);

-- Extension credential registry (issue #51): METADATA + a reference to the
-- credential row in the OMP auth broker. Secrets never leave the broker; the
-- broker_credential_id is the broker snapshot entry id ({provider, identityKey}
-- identify the row; the id is the opaque row key).
CREATE TABLE IF NOT EXISTS extension_credentials (
  id                   TEXT PRIMARY KEY, -- "ec_<uuid>"
  provider             TEXT NOT NULL,    -- extension provider id, e.g. 'github'
  identity_key         TEXT NOT NULL,    -- broker snapshot identityKey (email/accountId/projectId)
  owner                TEXT,             -- principal for scope='personal'; NULL for scope='org'
  scope                TEXT NOT NULL CHECK (scope IN ('org','personal')),
  broker_credential_id INTEGER NOT NULL, -- auth-broker credential row id (SnapshotEntry.id)
  created_at           INTEGER NOT NULL
);
-- One org-scoped credential per provider; one personal credential per (provider, owner).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_creds_org ON extension_credentials(provider) WHERE scope = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_creds_personal ON extension_credentials(provider, owner) WHERE scope = 'personal';

-- Org settings singleton (issue #67): id=1 row holding the JSON settings
-- blob (approvals, response_mode, memory.injection, extensions, repos,
-- model defaults). DB-first policy: org DB settings override the
-- config-file floor; per-space policy continues in spaces.policy_json.
-- The CHECK pins the singleton; the store upserts id=1.
CREATE TABLE IF NOT EXISTS org_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  settings   TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Durable UTC cron jobs (issue #86). The typed action registry validates
-- action names before insert; the runner disables unknown legacy rows.
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  id            TEXT PRIMARY KEY,        -- "sj_<uuid>"
  action        TEXT NOT NULL,
  cron          TEXT NOT NULL,           -- five-field UTC cron
  params        TEXT NOT NULL DEFAULT '{}',
  space_id      TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  next_fire_at  INTEGER NOT NULL,
  last_fired_at INTEGER,
  last_result   TEXT CHECK (last_result IN ('ok','error')),
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  space_id   TEXT,
  actor      TEXT NOT NULL,              -- principal or "agent:work:wi_x"
  event_type TEXT NOT NULL,              -- message.in, tool_call, policy.decision,
                                         -- approval.requested/resolved, delivery.requested, work_item.transition,
                                         -- extension.credential_resolved, ...
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
