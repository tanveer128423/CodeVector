# CodeVector Products API

A small backend to browse ~200,000 products **newest first**, **filter by category**,
and **paginate fast** — while staying **consistent as data changes**.

> Status: Day 1 complete (schema, fast seed, Express API, cursor pagination).
> Day 2: category filter polish + snapshot consistency. Day 3: deploy + UI.

## The two hard parts (and how this solves them)

### 1. Fast pagination at depth → keyset (cursor) pagination
`LIMIT/OFFSET` has to scan and throw away every row before the offset, so page
10,000 gets linearly slower. Instead we paginate by **keyset**: each response
returns an opaque `nextCursor` encoding the last row's `(created_at, id)`, and the
next query does:

```sql
WHERE (created_at, id) < ($cursor_created_at, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT $n
```

Backed by a composite index this is an **index range scan** — every page is
`O(limit)` no matter how deep you go. `id` is the tie-breaker so the order is
**total and deterministic** even when many rows share the same `created_at`.

### 2. Consistent view while data changes → snapshot
If products are inserted/updated mid-browse, naive pagination can show duplicates
or skip rows. We pin a **snapshot** timestamp at the start of a session and only
return rows with `created_at <= snapshot`. The first request gets a snapshot back;
the client passes it on every subsequent page. New writes simply fall outside the
frozen window, so the user never sees a dupe and never misses a row.

## Schema & indexes
See [`db/schema.sql`](db/schema.sql).

```sql
CREATE INDEX idx_products_created_id
  ON products (created_at DESC, id DESC);

CREATE INDEX idx_products_category_created_id
  ON products (category, created_at DESC, id DESC);
```

## Seeding (the fast way)
[`scripts/seed.js`](scripts/seed.js) generates all 200k rows **inside Postgres**
with a single `INSERT ... SELECT generate_series(...)` — no per-row round-trips.

## API

`GET /products`

| param      | description                                                        |
|------------|--------------------------------------------------------------------|
| `limit`    | page size, 1–100 (default 20)                                       |
| `category` | optional exact-match category filter                               |
| `cursor`   | opaque token from a previous response's `nextCursor`              |
| `snapshot` | ISO timestamp pinning the dataset; omit on first call to get one   |

Response:
```json
{
  "products": [ /* ... */ ],
  "nextCursor": "eyJjIjoi...",
  "snapshot": "2026-06-21T10:00:00.000Z",
  "limit": 20,
  "category": null
}
```

Other endpoints: `GET /health`, `GET /categories`.

## Run locally
```bash
cp .env.example .env        # fill in DATABASE_URL (Neon/Supabase)
npm install
npm run migrate             # create table + indexes
npm run seed                # generate 200k products (SEED_COUNT to change)
npm start                   # http://localhost:3000
```

## Deploy
- **DB:** Neon / Supabase (free). Put the connection string in `DATABASE_URL`.
- **API:** Render (see [`render.yaml`](render.yaml)). Set `DATABASE_URL`, then run
  `npm run migrate && npm run seed` once against the hosted DB.

## Stack
Node.js · Express · PostgreSQL (`pg`).
