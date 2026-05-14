CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS eeg_raw (
  ts  TIMESTAMPTZ NOT NULL,
  ch  SMALLINT    NOT NULL,
  uv  REAL        NOT NULL
);
SELECT create_hypertable('eeg_raw', 'ts',
  chunk_time_interval => INTERVAL '1 hour',
  if_not_exists => TRUE);

ALTER TABLE eeg_raw SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'ch',
  timescaledb.compress_orderby = 'ts'
);
SELECT add_compression_policy('eeg_raw', INTERVAL '1 day', if_not_exists => TRUE);
SELECT add_retention_policy('eeg_raw', INTERVAL '14 days', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS eeg_features (
  ts    TIMESTAMPTZ NOT NULL,
  ch    SMALLINT    NOT NULL,
  alpha REAL        NOT NULL,
  beta  REAL,
  theta REAL
);
-- 2026-05-14 migration: add delta/gamma bands (idempotent for fresh + existing DBs).
ALTER TABLE eeg_features ADD COLUMN IF NOT EXISTS delta REAL;
ALTER TABLE eeg_features ADD COLUMN IF NOT EXISTS gamma REAL;
SELECT create_hypertable('eeg_features', 'ts',
  chunk_time_interval => INTERVAL '6 hours',
  if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS events (
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind    TEXT        NOT NULL,
  payload JSONB
);
SELECT create_hypertable('events', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts DESC);

-- 2026-05-14 migration: per-command Roomba event log.
-- One row per `roomba/cmd` MQTT publish (manual joystick, decision_svc,
-- and the autopilot orchestrator all funnel through here). Lets the UI
-- rehydrate the trajectory/timeline after a reload, and supports joining
-- with eeg_features for research queries like "what was the EEG state
-- when autopilot decided X". Images are not stored (too heavy).
CREATE TABLE IF NOT EXISTS roomba_events (
  ts      TIMESTAMPTZ NOT NULL,
  cmd     TEXT        NOT NULL,         -- forward / left / right / back / stop
  ok      BOOLEAN     NOT NULL,
  src     TEXT        NOT NULL,         -- 'manual' | 'autopilot' | 'decision'
  reason  TEXT,                         -- autopilot only
  mode    TEXT,                         -- autopilot only: 'free' | 'goal'
  goal    TEXT,                         -- autopilot only
  model   TEXT,                         -- autopilot only
  err     TEXT                          -- dispatch failure message
);
SELECT create_hypertable('roomba_events', 'ts',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS roomba_events_src_ts ON roomba_events (src, ts DESC);
SELECT add_retention_policy('roomba_events', INTERVAL '30 days', if_not_exists => TRUE);
