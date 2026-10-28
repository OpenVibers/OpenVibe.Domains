-- phase: expand
-- OpenVibe.Domains' control panel (plan 2026-10-28 §5.1, DOM-2). A person connects a registrar or DNS account through
-- its official API; the credential itself is a Network project secret in the person's own project (ADR-056), granted
-- to `domains` for reveal to the provider's origin, so only its name lives here. Every DNS change is a proposal with
-- its diff and its rollback, applied only once its person approves it; the audit keeps who did what.

CREATE TABLE IF NOT EXISTS domains_connections (
    id           text COLLATE "C" PRIMARY KEY,                -- dcn_<ULID>
    subject      text COLLATE "C" NOT NULL,                   -- usr_… the person who connected it
    provider     text COLLATE "C" NOT NULL,                   -- cloudflare
    label        text NOT NULL,                               -- the person's own name for it
    project_id   text COLLATE "C" NOT NULL,                   -- prj_… the Network project holding the secret
    environment  text COLLATE "C" NOT NULL DEFAULT 'production',
    secret_name  text COLLATE "C" NOT NULL,                   -- the secret's name in that project, never its value
    status       text COLLATE "C" NOT NULL DEFAULT 'active',  -- active | broken | removed
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    checked_at   timestamptz,
    removed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS domains_connections_subject ON domains_connections (subject) WHERE status <> 'removed';

-- The zones a connection holds, as the provider last answered (a cache: the provider stays the truth).
CREATE TABLE IF NOT EXISTS domains_zones (
    connection_id text COLLATE "C" NOT NULL REFERENCES domains_connections (id) ON DELETE CASCADE,
    zone_id       text COLLATE "C" NOT NULL,                  -- the provider's id
    name          text COLLATE "C" NOT NULL,                  -- example.com
    status        text,
    name_servers  jsonb NOT NULL DEFAULT '[]'::jsonb,
    plan          text,
    synced_at     timestamptz NOT NULL,
    PRIMARY KEY (connection_id, zone_id)
);
CREATE INDEX IF NOT EXISTS domains_zones_name ON domains_zones (name);

-- A change waiting for its person (domains.proposal@1). changes: [{ op, record_id, before, after }]; rollback is the
-- inverse, completed with the provider's ids as each change is applied.
CREATE TABLE IF NOT EXISTS domains_proposals (
    id             text COLLATE "C" PRIMARY KEY,              -- dpr_<ULID>
    subject        text COLLATE "C" NOT NULL,
    connection_id  text COLLATE "C" NOT NULL REFERENCES domains_connections (id),
    zone_id        text COLLATE "C" NOT NULL,
    domain         text COLLATE "C" NOT NULL,
    title          text NOT NULL,
    why            text,
    risk           text,
    changes        jsonb NOT NULL,
    rollback       jsonb NOT NULL DEFAULT '[]'::jsonb,
    status         text COLLATE "C" NOT NULL DEFAULT 'pending', -- pending | applying | applied | declined | failed | rolled_back | expired
    created_by     text COLLATE "C" NOT NULL,                 -- user:usr_… | agent:… | service:…
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,
    decided_at     timestamptz,
    decided_by     text COLLATE "C",
    applied_at     timestamptz,
    rolled_back_at timestamptz,
    result         jsonb,
    error          text
);
CREATE INDEX IF NOT EXISTS domains_proposals_subject ON domains_proposals (subject, status, created_at DESC);

CREATE TABLE IF NOT EXISTS domains_audit (
    id            bigserial PRIMARY KEY,
    subject       text COLLATE "C" NOT NULL,
    at            timestamptz NOT NULL DEFAULT now(),
    action        text COLLATE "C" NOT NULL,                  -- connection.added | proposal.created | proposal.applied | …
    connection_id text COLLATE "C",
    proposal_id   text COLLATE "C",
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS domains_audit_subject ON domains_audit (subject, at DESC);

-- Account export and deletion (ADR-033, openvibe-sdk/account-data): the events already applied, so a redelivery is a
-- no-op.
CREATE TABLE IF NOT EXISTS account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);
