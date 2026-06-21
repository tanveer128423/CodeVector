'use strict';

// Benchmarks keyset (cursor) pagination vs OFFSET pagination at increasing depth.
// For each depth D we:
//   1. find the boundary row at rank D (one-time, not counted)
//   2. time the keyset query  WHERE (created_at,id) < boundary  LIMIT page
//   3. time the equivalent    ORDER BY ... LIMIT page OFFSET D
// We run several iterations and report the best (min) time to reduce noise.
//
// Expectation: keyset stays ~constant; OFFSET grows roughly linearly with depth.

const { pool } = require('../src/db');

const PAGE = 20;
const ITERS = 5;
const DEPTHS = [0, 1000, 10000, 50000, 100000, 150000, 199000];

async function timeit(fn) {
  let best = Infinity;
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

async function main() {
  console.log(`page size=${PAGE}, iterations=${ITERS} (reporting best ms)\n`);
  console.log('depth      keyset(ms)   offset(ms)   speedup');
  console.log('-------------------------------------------------');

  for (const D of DEPTHS) {
    const { rows } = await pool.query(
      'SELECT created_at, id FROM products ORDER BY created_at DESC, id DESC OFFSET $1 LIMIT 1',
      [D]
    );
    if (!rows.length) continue;
    const b = rows[0];

    const keyset = await timeit(() =>
      pool.query(
        `SELECT id,name,category,price,created_at,updated_at
         FROM products
         WHERE (created_at, id) < ($1::timestamptz, $2::bigint)
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [b.created_at, b.id, PAGE]
      )
    );

    const offset = await timeit(() =>
      pool.query(
        `SELECT id,name,category,price,created_at,updated_at
         FROM products
         ORDER BY created_at DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [PAGE, D]
      )
    );

    const speedup = (offset / keyset).toFixed(1);
    console.log(
      String(D).padEnd(10) +
        keyset.toFixed(2).padStart(10) +
        offset.toFixed(2).padStart(13) +
        `   ${speedup}x`.padStart(10)
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
