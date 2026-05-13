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
