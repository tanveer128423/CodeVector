'use strict';

const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// Managed Postgres providers (Neon/Supabase) require SSL. We keep it relaxed
// (rejectUnauthorized: false) because their certs are signed by their own CA and
// we connect over a trusted network path. For a stricter setup you'd pin the CA.
const rawUrl = process.env.DATABASE_URL;
const needsSsl = /neon\.tech|supabase\.co|render\.com|sslmode=/.test(rawUrl);

// Strip sslmode from the URL and configure SSL explicitly via the `ssl` option.
// This avoids pg-connection-string's noisy "sslmode treated as verify-full"
// deprecation warning while keeping the connection encrypted.
const connectionString = rawUrl.replace(/([?&])sslmode=[^&]*/i, '$1').replace(/[?&]$/, '');

const pool = new Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
};
