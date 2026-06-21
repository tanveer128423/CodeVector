# CodeVector Products API

A small backend to browse ~200,000 products **newest first**, **filter by category**,
and **paginate fast** — while staying **consistent as data changes**.

> Status: Day 1–2 complete (schema, fast seed, keyset API, snapshot consistency,
> a correctness proof script, and benchmarks). Day 3: deploy + optional UI.

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

### Why order/snapshot on `created_at`, not `updated_at`?
This is the subtle part. The sort key controls a row's *position*; for keyset
pagination to be stable, **a row's position must not change while you page through
it**. `created_at` is set once at insert and never changes → a row's position is
**immutable**, so:

| Event during browse | With `created_at` ordering |
|---|---|
| **Insert** new product | `created_at > snapshot` → excluded from this session. No dupe/skip. |
| **Update** existing product (price, name, even `updated_at`) | `created_at` unchanged → row stays in the same slot. Seen **exactly once**, and you read its **latest** values live (fresh data, still consistent). |

If we ordered/snapshotted on `updated_at` instead, an update *moves* a row to the
top of the feed. That fundamentally conflicts with "never see the same product
twice": a row you already passed could jump ahead and reappear, or `updated_at <=
snapshot` would make a just-edited row vanish mid-session (a skip). A true
"recently-updated" feed with a no-duplicate guarantee would need a different
mechanism (e.g. a monotonic version/sequence column, or snapshotting the whole
dataset into a materialized view). For "browse newest products, stay consistent,"
ordering on the immutable `created_at` is the correct, simplest choice — and I read
each row's current fields live so users still see up-to-date prices.

This is all **verified by a script**, not just claimed — see below.

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

## Proof it works (not just claims)

### Correctness under concurrent writes — `npm run test:consistency`
Opens a browsing session, then **mid-walk** inserts 50 new products *and* updates
50 existing-but-not-yet-seen products, then paginates to the end and asserts:

```
PASS: A) No duplicate products across all pages
PASS: B) Count matches snapshot set (200000 === 200000)
PASS: B) No missing rows (0 missing)
PASS: C) None of the 50 new products appeared (0 leaked)
PASS: D) All 50 updated rows still appeared exactly once
PASS: D) Updated rows show fresh price (live read), 50/50
```

### Performance — `npm run benchmark` (real 200k rows, Postgres 18)
Keyset stays flat; OFFSET degrades linearly with depth:

```
depth      keyset(ms)   offset(ms)   speedup
-------------------------------------------------
0               1.40         1.21      0.9x
10000           1.01         5.92      5.9x
50000           0.98        31.93     32.7x
100000          0.89        59.21     66.3x
199000          0.95        96.28    101.3x
```

`EXPLAIN ANALYZE` confirms why: keyset is an **Index Scan** (~3 buffer hits,
0.1 ms), while deep OFFSET does a **Seq Scan + external merge sort to disk**
(~2300 buffers, 240 ms).

## Run locally
```bash
cp .env.example .env        # fill in DATABASE_URL (Neon/Supabase)
npm install
npm run migrate             # create table + indexes
npm run seed                # generate 200k products (SEED_COUNT to change)
npm start                   # http://localhost:3000

npm run benchmark           # keyset vs OFFSET timings
npm run test:consistency    # proves no-dupe/no-skip under concurrent writes
```

## Deploy
- **DB:** Neon / Supabase (free). Put the connection string in `DATABASE_URL`.
- **API:** Render (see [`render.yaml`](render.yaml)). Set `DATABASE_URL`, then run
  `npm run migrate && npm run seed` once against the hosted DB.

## Tradeoffs & what I'd improve with more time
- **Snapshot stored client-side.** It's just a timestamp echoed back by the client,
  so it's stateless and scales trivially. Downside: a client could send a future
  snapshot. I clamp/validate it; a stricter version would cap it at `now()` server-side.
- **No total count.** Returning an exact "N of M" count would need a `COUNT(*)`
  that scans the filtered set. I return `nextCursor`/`hasMore` instead (O(limit)).
  An approximate count via `pg_class.reltuples` could be added cheaply if needed.
- **Snapshot uses `created_at <= snapshot`.** If two rows shared the exact same
  microsecond timestamp, the `id` tie-breaker still gives a total order — covered.
- **`updated_at`-ordered feed** isn't supported by design (see rationale above); if
  the product needed a "recently changed" view with the same guarantees, I'd add a
  monotonic `version BIGSERIAL` / sequence column and paginate on that.
- More: rate limiting, request validation middleware, integration tests in CI,
  and connection-pool tuning for the deployment's instance size.

## How I used AI
AI helped scaffold the Express boilerplate and draft the seed SQL quickly. What it
got wrong (and I caught by running a **real** Postgres locally): the first seed used
`CROSS JOIN LATERAL (SELECT random() ...)` which Postgres evaluated **once**, giving
all 200k rows identical timestamps/categories — only visible once I queried actual
data. I fixed it by moving `random()` into a subquery's `SELECT` list over
`generate_series` (per-row evaluation), then verified 200k distinct timestamps.

## Stack
Node.js · Express · PostgreSQL (`pg`).
