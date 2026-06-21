'use strict';

// Seeds ~200k products FAST by generating all rows inside Postgres with
// generate_series(). This avoids 200k round-trips from Node (the slow approach).
// The whole dataset is built in a single INSERT ... SELECT statement.
//
// Run:  npm run migrate && npm run seed
// Tune: SEED_COUNT env var (default 200000).

const { pool } = require('../src/db');

const COUNT = parseInt(process.env.SEED_COUNT || '200000', 10);

const CATEGORIES = [
  'Electronics', 'Books', 'Home & Kitchen', 'Toys', 'Sports',
  'Clothing', 'Beauty', 'Automotive', 'Garden', 'Office',
  'Grocery', 'Pet Supplies', 'Health', 'Music', 'Games',
];

const ADJECTIVES = [
  'Premium', 'Eco', 'Smart', 'Classic', 'Deluxe', 'Compact',
  'Pro', 'Ultra', 'Vintage', 'Modern', 'Portable', 'Wireless',
];

const NOUNS = [
  'Widget', 'Gadget', 'Bottle', 'Charger', 'Lamp', 'Backpack',
  'Speaker', 'Mug', 'Notebook', 'Headset', 'Keyboard', 'Chair',
];

async function main() {
  console.time('seed');
  console.log(`Seeding ${COUNT} products...`);

  // Build a few arrays in Postgres so we can index into them with random offsets.
  // created_at is spread across the last ~365 days so "newest first" is meaningful;
  // updated_at starts equal to created_at (some can be bumped later to simulate edits).
  const sql = `
    INSERT INTO products (name, category, price, created_at, updated_at)
    SELECT
      adj.v || ' ' || noun.v || ' #' || g                         AS name,
      cat.v                                                        AS category,
      ROUND((5 + random() * 995)::numeric, 2)                     AS price,
      ts                                                          AS created_at,
      ts                                                          AS updated_at
    FROM generate_series(1, $1) AS g
    CROSS JOIN LATERAL (
      SELECT (now() - (random() * interval '365 days')) AS ts
    ) t
    CROSS JOIN LATERAL (
      SELECT ($2::text[])[1 + floor(random() * array_length($2::text[], 1))::int] AS v
    ) cat
    CROSS JOIN LATERAL (
      SELECT ($3::text[])[1 + floor(random() * array_length($3::text[], 1))::int] AS v
    ) adj
    CROSS JOIN LATERAL (
      SELECT ($4::text[])[1 + floor(random() * array_length($4::text[], 1))::int] AS v
    ) noun;
  `;

  const res = await pool.query(sql, [COUNT, CATEGORIES, ADJECTIVES, NOUNS]);
  console.log(`Inserted ${res.rowCount} rows.`);

  const { rows } = await pool.query('SELECT count(*)::int AS c FROM products');
  console.log(`Total products in table: ${rows[0].c}`);

  console.timeEnd('seed');
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
