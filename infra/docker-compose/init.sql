-- Serpent Arena local development schema bootstrap.
-- Application migrations must be additive (expand/contract); do not place destructive DDL here.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migration_guard (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (id = 1)
);

INSERT INTO schema_migration_guard (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
