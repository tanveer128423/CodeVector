'use strict';

const express = require('express');
const db = require('../db');
const { encodeCursor, decodeCursor } = require('../cursor');

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /products
 *
 * Query params:
 *   limit     - page size (1..100, default 20)
 *   category  - optional exact-match category filter
 *   cursor    - opaque token from a previous response's `nextCursor`
 *   snapshot  - ISO timestamp pinning the dataset for a stable browsing session.
 *               If omitted on the first request, the server creates one and
 *               returns it; clients should pass it back on every subsequent page.
 *
 * Why this design:
 *   - Keyset (cursor) pagination instead of OFFSET. OFFSET N must scan and discard
 *     N rows, so deep pages get linearly slower. Keyset uses (created_at, id) as an
 *     index range start, so every page is O(limit) regardless of depth.
 *   - (created_at DESC, id DESC) ordering with id as tie-breaker => total, stable
 *     order even when many rows share created_at.
 *   - snapshot freezes the view: we only show rows with created_at <= snapshot.
 *     While someone browses, new inserts/updates can't shift their pages, so they
 *     never see a duplicate and never skip a row.
 */
router.get('/products', async (req, res, next) => {
  try {
    // --- limit ---
    let limit = parseInt(req.query.limit, 10);
    if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) limit = MAX_LIMIT;

    // --- snapshot (stable session) ---
    let snapshot = req.query.snapshot;
    if (snapshot) {
      const d = new Date(snapshot);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: 'Invalid snapshot timestamp' });
      }
      snapshot = d.toISOString();
    } else {
      snapshot = new Date().toISOString();
    }

    // --- category ---
    const category = req.query.category ? String(req.query.category) : null;

    // --- cursor ---
    let cursor = null;
    if (req.query.cursor) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
    }

    // --- build query ---
    const params = [];
    const where = [];

    // Snapshot bound: only rows that existed (by created_at) at session start.
    params.push(snapshot);
    where.push(`created_at <= $${params.length}`);

    if (category) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }

    if (cursor) {
      // Row-value comparison gives us the clean keyset predicate. With DESC order
      // we want rows "after" the cursor, i.e. strictly smaller (created_at, id).
      params.push(cursor.created_at);
      const cAt = params.length;
      params.push(cursor.id);
      const cId = params.length;
      where.push(`(created_at, id) < ($${cAt}::timestamptz, $${cId}::bigint)`);
    }

    // Fetch one extra row to know if there's a next page without a COUNT.
    params.push(limit + 1);
    const limitParam = params.length;

    const sql = `
      SELECT id, name, category, price, created_at, updated_at
      FROM products
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC
      LIMIT $${limitParam}
    `;

    const { rows } = await db.query(sql, params);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = encodeCursor({ created_at: last.created_at.toISOString(), id: last.id });
    }

    res.json({
      products: pageRows,
      nextCursor,
      snapshot,
      limit,
      category: category || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
