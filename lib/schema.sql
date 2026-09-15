-- Irrigation Scheduler schema (Postgres / Supabase)

CREATE TABLE IF NOT EXISTS users (
    id                   SERIAL PRIMARY KEY,
    username             TEXT UNIQUE NOT NULL,
    password_hash        TEXT NOT NULL,
    full_name            TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('admin','crew')),
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zones (
    id                 SERIAL PRIMARY KEY,
    number             INTEGER UNIQUE NOT NULL,
    name               TEXT NOT NULL,
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    hydrawise_relay_id TEXT
);

CREATE TABLE IF NOT EXISTS programs (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    start_time          TEXT NOT NULL,          -- "HH:MM" in America/New_York
    days_mask           INTEGER NOT NULL,        -- bit0=Sun ... bit6=Sat
    seasonal_adjust_pct INTEGER NOT NULL DEFAULT 100,
    created_by          INTEGER REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 'scheduled' programs fire automatically at start_time on their days_mask days.
-- 'on_demand' programs never fire on their own — they exist purely so a
-- crew/admin can hit "Run Now" and start a preset group of zones instantly
-- (e.g. a hot-spot run that can't be on a fixed timer because golfers may be
-- on the green). Added via ALTER so this applies to already-deployed databases too.
ALTER TABLE programs ADD COLUMN IF NOT EXISTS program_type TEXT NOT NULL DEFAULT 'scheduled';

CREATE TABLE IF NOT EXISTS program_zones (
    id               SERIAL PRIMARY KEY,
    program_id       INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    zone_id          INTEGER NOT NULL REFERENCES zones(id),
    duration_minutes INTEGER NOT NULL,
    sort_order       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_log (
    id               SERIAL PRIMARY KEY,
    ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
    zone_id          INTEGER REFERENCES zones(id),
    program_id       INTEGER REFERENCES programs(id),
    action           TEXT NOT NULL CHECK (action IN ('run','stop','runall','stopall','suspend','resume')),
    duration_minutes INTEGER,
    triggered_by     TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN ('success','error')),
    message          TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Zones queued to fire later as part of a sequential "Run All" or program
-- run. This exists so a multi-zone sequence survives a server restart:
-- everything after the FIRST zone used to be scheduled purely in-memory
-- (setTimeout), which meant a Render redeploy or restart silently lost
-- every zone still waiting its turn, with no error logged anywhere. The
-- once-a-minute scheduler tick now also sweeps this table, so a queued
-- zone fires even if the process that queued it is long gone by the time
-- fire_at arrives.
CREATE TABLE IF NOT EXISTS pending_zone_runs (
    id            SERIAL PRIMARY KEY,
    zone_id       INTEGER NOT NULL REFERENCES zones(id),
    program_id    INTEGER REFERENCES programs(id),
    action        TEXT NOT NULL CHECK (action IN ('run','stop')),
    minutes       INTEGER,
    triggered_by  TEXT NOT NULL,
    fire_at       TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_log_ts ON run_log(ts);
CREATE INDEX IF NOT EXISTS idx_program_zones_program ON program_zones(program_id);
CREATE INDEX IF NOT EXISTS idx_pending_zone_runs_fire_at ON pending_zone_runs(fire_at);
