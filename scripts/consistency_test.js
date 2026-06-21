'use strict';

// Proves the "no duplicates, no missing rows while data changes" guarantee.
//
// Scenario (simulating a user browsing while writers are active):
//   1. Start a browsing session: fetch page 1 (server hands back a `snapshot`).
//   2. MID-BROWSE, mutate the table:
//        - INSERT 50 brand-new products (created_at = now() > snapshot)
//        - UPDATE 50 existing, not-yet-seen products (bump price + updated_at;
//          created_at stays the same)
//   3. Continue paginating to the end using (snapshot + cursor), collecting ids.
//
// Assertions:
//   A. No id appears twice         -> no duplicates
//   B. Collected ids == exactly the set of ids that existed at snapshot
//                                   -> nothing skipped, nothing extra
//   C. None of the 50 new ids show up (they're outside the frozen window)
//   D. An updated-but-pre-existing row still appears exactly once, and we read
//      its NEW price live -> updates don't break pagination, data stays fresh.

const express = require('express');
const http = require('http');
const { pool } = require('../src/db');
const productsRouter = require('../src/routes/products');

const PAGE = 100;

function startServer() {
  const app = express();
  app.use('/', productsRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function get(port, qs) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/products${qs}`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log('PASS: ' + msg);
}

async function main() {
  const { server, port } = await startServer();

  // --- Step 1: open session, fetch page 1 ---
  const first = await get(port, `?limit=${PAGE}`);
  const snapshot = first.snapshot;
  console.log(`Session snapshot = ${snapshot}`);

  const seen = new Map(); // id -> row (catches duplicates)
  const recordPage = (rows) => {
    for (const r of rows) {
      if (seen.has(r.id)) {
        throw new Error(`DUPLICATE id ${r.id} seen twice!`);
      }
      seen.set(r.id, r);
    }
  };
  recordPage(first.products);
  let cursor = first.nextCursor;

  // --- Step 2: mutate mid-browse ---
  // Insert 50 new products (created_at default now() => after snapshot).
  const ins = await pool.query(
    `INSERT INTO products (name, category, price)
     SELECT 'CONCURRENT NEW #' || g, 'Electronics', 9.99
     FROM generate_series(1, 50) g
     RETURNING id`
  );
  const newIds = new Set(ins.rows.map((r) => r.id));
  console.log(`Inserted 50 new products (ids ${ins.rows[0].id}..${ins.rows[49].id}).`);

  // Update 50 existing products that we have NOT seen yet (older created_at, so
  // they're still ahead of our cursor). Bump price + updated_at; created_at stays.
  const upd = await pool.query(
    `WITH victims AS (
        SELECT id FROM products
        WHERE created_at <= $1 AND id NOT IN (SELECT unnest($2::bigint[]))
        ORDER BY created_at ASC, id ASC      -- oldest: we reach them last
        LIMIT 50
     )
     UPDATE products p
     SET price = 1234.56, updated_at = now()
     FROM victims v
     WHERE p.id = v.id
     RETURNING p.id`,
    [snapshot, Array.from(seen.keys())]
  );
  const updatedIds = new Set(upd.rows.map((r) => r.id));
  console.log(`Updated 50 pre-existing, not-yet-seen products (price -> 1234.56).`);

  // --- Step 3: paginate to the end ---
  let pages = 1;
  while (cursor) {
    const res = await get(port, `?limit=${PAGE}&snapshot=${encodeURIComponent(snapshot)}&cursor=${cursor}`);
    recordPage(res.products);
    cursor = res.nextCursor;
    pages++;
  }
  console.log(`Walked ${pages} pages, collected ${seen.size} products.\n`);

  // --- Step 4: assertions ---
  // A: duplicates already throw in recordPage; reaching here means none.
  assert(true, 'A) No duplicate products across all pages');

  // B: collected set == ids that existed at snapshot.
  const snap = await pool.query('SELECT id FROM products WHERE created_at <= $1', [snapshot]);
  const snapIds = new Set(snap.rows.map((r) => r.id));
  assert(seen.size === snapIds.size, `B) Count matches snapshot set (${seen.size} === ${snapIds.size})`);
  let missing = 0;
  for (const id of snapIds) if (!seen.has(id)) missing++;
  assert(missing === 0, `B) No missing rows (${missing} missing)`);

  // C: none of the concurrently-inserted ids leaked into the session.
  let leaked = 0;
  for (const id of newIds) if (seen.has(id)) leaked++;
  assert(leaked === 0, `C) None of the 50 new products appeared (${leaked} leaked)`);

  // D: updated pre-existing rows appear exactly once AND reflect the new price.
  let updSeen = 0;
  let freshPrice = 0;
  for (const id of updatedIds) {
    if (seen.has(id)) {
      updSeen++;
      if (Number(seen.get(id).price) === 1234.56) freshPrice++;
    }
  }
  assert(updSeen === updatedIds.size, `D) All ${updatedIds.size} updated rows still appeared exactly once`);
  assert(freshPrice === updatedIds.size, `D) Updated rows show fresh price (live read), ${freshPrice}/${updatedIds.size}`);

  // Cleanup the rows this test created/changed so it's repeatable.
  await pool.query('DELETE FROM products WHERE id = ANY($1::bigint[])', [Array.from(newIds)]);
  console.log('\nCleaned up 50 inserted test rows.');

  server.close();
  await pool.end();
  console.log('\nAll consistency checks passed.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
