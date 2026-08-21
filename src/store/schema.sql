-- Latest Bottega application schema. The ordered migration registry applies
-- this idempotent definition first, then records every historical upgrade.

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
  assignee     TEXT,                     -- who owns the item (issue #159): the requester at creation,
                                         -- the executor's identity once claimed; NULL only on pre-#159 rows
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
  skills       TEXT NOT NULL DEFAULT '[]',-- JSON array of explicit task-level skill names (issues #234/#235)
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
  id                              TEXT PRIMARY KEY, -- stable "ec_<uuid>" connection id
  provider                        TEXT NOT NULL,    -- extension manifest id, e.g. 'github'
  vault_provider                  TEXT NOT NULL,    -- credential-store namespace owned by this connection
  identity_key                    TEXT NOT NULL,    -- redacted broker identity label source
  owner                           TEXT,             -- principal for scope='personal'; NULL for scope='org'
  scope                           TEXT NOT NULL CHECK (scope IN ('org','personal')),
  broker_credential_id            INTEGER NOT NULL, -- auth-broker credential row id (SnapshotEntry.id)
  pending_vault_provider          TEXT,             -- staged replacement vault namespace
  pending_broker_credential_id    INTEGER,          -- staged replacement authority
  pending_identity_key            TEXT,             -- staged replacement identity metadata
  retiring_broker_credential_id   INTEGER,          -- old authority awaiting replacement cleanup
  status                          TEXT NOT NULL DEFAULT 'active'
                                  CHECK (status IN (
                                    'active',
                                    'replacing',
                                    'replace_cleanup_pending',
                                    'disconnecting_boundary',
                                    'disconnecting_authority',
                                    'disconnected'
                                  )),
  revision                        INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at                      INTEGER NOT NULL,
  updated_at                      INTEGER NOT NULL
);
-- One durable connection per org/provider and per personal provider/owner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_creds_org ON extension_credentials(provider) WHERE scope = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_creds_personal ON extension_credentials(provider, owner) WHERE scope = 'personal';

-- Runtime extension registry (issue #233): the STORE-backed registry for
-- runtime-registered extension manifests (the catalog connect path's durable
-- record). MACHINE STATE — never a repo file: boot merges the pinned seeds
-- (config/extensions snapshots) + this persisted runtime set into the live
-- registry, and the egress generator merges the same set into the emitted
-- configs. The snapshot column holds the full PinnedSnapshot document
-- (schema/extensionId/pinnedAt/source/manifest — the registry's fail-closed
-- parse validates it on read).
CREATE TABLE IF NOT EXISTS extension_registry (
  id            TEXT PRIMARY KEY,
  snapshot      TEXT NOT NULL,
  registered_by TEXT NOT NULL,
  space_id      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- One-time upload links carry no secret. Optional replacement columns bind
-- a browser upload to one stable connection revision.
CREATE TABLE IF NOT EXISTS upload_tokens (
  id                TEXT PRIMARY KEY,
  token             TEXT NOT NULL UNIQUE,
  extension         TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('org','personal')),
  actor             TEXT NOT NULL,
  space_id          TEXT,
  label             TEXT NOT NULL,
  connection_id     TEXT,
  expected_revision INTEGER,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  CHECK ((connection_id IS NULL) = (expected_revision IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_upload_tokens_actor ON upload_tokens(actor);

-- Generic MCP OAuth flows (issue #198): the pending authorization-code +
-- PKCE flow for hosted OAuth MCPs (Notion, GitHub, Linear). The connect
-- tool mints one row per flow — the row carries ONLY the flow bookkeeping
-- (PKCE verifier, registered client info, discovery state, the
-- authorization URL), NEVER a token; the token lands in the vault when the
-- callback exchanges the code. The `token` column doubles as the OAuth
-- `state` parameter: opaque, single-use, short-TTL. Shared via the SQLite
-- file so the server process (callback endpoint) and per-session MCP child
-- processes (connect mint) agree on the same flows.
CREATE TABLE IF NOT EXISTS oauth_flows (
  id           TEXT PRIMARY KEY,      -- "of_<uuid>"
  token        TEXT NOT NULL UNIQUE,  -- opaque 128-bit random; the OAuth state
  provider     TEXT NOT NULL,         -- extension provider id, e.g. 'notion'
  scope        TEXT NOT NULL CHECK (scope IN ('org','personal')),
  actor        TEXT NOT NULL,         -- principal the connect runs for
  space_id     TEXT,
  label        TEXT NOT NULL,         -- provider label, rendered in messages
  server_url   TEXT NOT NULL,         -- the MCP endpoint the flow targets
  redirect_uri TEXT NOT NULL,         -- the registered callback URL (the exchange's redirect_uri)
  flow         TEXT NOT NULL,         -- JSON: {codeVerifier, clientInformation, discoveryState, authorizationUrl}
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL       -- created + short TTL (issue #198)
);
CREATE INDEX IF NOT EXISTS idx_oauth_flows_actor ON oauth_flows(actor);

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
  enabled       INTEGER NOT NULL DEFAULT 1,
  revision      INTEGER NOT NULL DEFAULT 1
);

-- One durable execution per cron occurrence or explicit run-now invocation
-- (issue #308). The row snapshots the job at enqueue time, so an edit that
-- wins after the claim affects future occurrences without rewriting an
-- already claimed fire.
CREATE TABLE IF NOT EXISTS scheduler_invocations (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  action        TEXT NOT NULL,
  params        TEXT NOT NULL,
  space_id      TEXT,
  source        TEXT NOT NULL CHECK (source IN ('scheduled','manual')),
  scheduled_for INTEGER,
  requested_at  INTEGER NOT NULL,
  job_revision  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','completed')),
  claimed_at    INTEGER,
  completed_at  INTEGER,
  result        TEXT CHECK (result IN ('ok','error'))
);
CREATE INDEX IF NOT EXISTS idx_scheduler_invocations_claim
  ON scheduler_invocations(status, requested_at, id);
CREATE INDEX IF NOT EXISTS idx_scheduler_invocations_job
  ON scheduler_invocations(job_id, requested_at, id);

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
CREATE INDEX IF NOT EXISTS idx_audit_event_ts ON audit(event_type, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_space_ts ON audit(space_id, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ts ON audit(actor, ts DESC, id DESC);

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

-- Worker → server outbox (epic #170 precondition 2, issue #187): the
-- consumable signaling channel that replaces scanning the append-only
-- audit table as a queue. Workers (the executor container, which never
-- holds Slack tokens) write one row per completed job; the server post
-- seam consumes rows with indexed watermarked queries and marks them
-- posted. Audit stays pure evidence; the row id is the dedupe key across
-- restarts (one id threads enqueue → claim → run → outbox → post).
CREATE TABLE IF NOT EXISTS outbox (
  id         TEXT PRIMARY KEY,              -- the job id (one id across the whole lifecycle)
  kind       TEXT NOT NULL CHECK (kind IN ('git','extension','kb','scheduled','work_item','ingest_poll')),
  payload    TEXT NOT NULL,                 -- JSON payload (never secrets; the worker has none)
  space      TEXT,                          -- space id the result belongs to (nullable)
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','posted','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,    -- retry bookkeeping; 0 on first write
  created_at INTEGER NOT NULL,
  posted_at  INTEGER                        -- set when the consumer marks the row posted
);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON outbox(status, created_at);

-- Worker job bus (epic #170): the claim loop's queue. One row per job; the
-- envelope id is the work item id for git/extension jobs (debuggability —
-- one id across enqueue -> claim -> run -> outbox -> post). `lease_until`
-- carries the running lease while claimed, and doubles as the backoff
-- not-before gate while queued (a requeued job is claimable again only
-- after its backoff elapses).
CREATE TABLE IF NOT EXISTS worker_jobs (
  id          TEXT PRIMARY KEY,      -- envelope id ("wi_..." for git/extension)
  kind        TEXT NOT NULL CHECK (kind IN ('git','extension','kb','scheduled','ingest_poll')),
  payload     TEXT NOT NULL,         -- JSON envelope payload
  space_id    TEXT,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','completed','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_jobs_queue ON worker_jobs(status, created_at);

-- Durable per-provider ingest poll cursor (issue #101): the worker's
-- fetch/validate leg persists the poll boundary here so a restart resumes
-- after the last processed event instead of re-seeing the whole window.
CREATE TABLE IF NOT EXISTS ingest_watermark (
  provider   TEXT PRIMARY KEY,   -- 'github' | 'linear'
  cursor     TEXT NOT NULL,      -- ms-epoch boundary string
  updated_at INTEGER NOT NULL
);
