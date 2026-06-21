-- Products table.
-- id is BIGSERIAL so it is monotonic and works as a tie-breaker for keyset pagination.
CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL   PRIMARY KEY,
  name        TEXT        NOT NULL,
  category    TEXT        NOT NULL,
  price       NUMERIC(10, 2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for the default "newest first" feed.
-- We order by (created_at DESC, id DESC). Because many rows can share the same
-- created_at, the id is the tie-breaker so ordering is total and deterministic.
-- This composite index lets keyset pagination ((created_at, id) < (?, ?)) be an
-- index range scan instead of a full sort + offset.
CREATE INDEX IF NOT EXISTS idx_products_created_id
  ON products (created_at DESC, id DESC);

-- Index for category-filtered browsing. category is the leading column so the
-- planner can seek straight to one category, then range-scan by (created_at, id).
CREATE INDEX IF NOT EXISTS idx_products_category_created_id
  ON products (category, created_at DESC, id DESC);
