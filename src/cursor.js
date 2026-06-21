'use strict';

// A cursor encodes the position of the last row we returned: its created_at and id.
// We base64url-encode a tiny JSON blob so it's opaque to clients (they should treat
// it as a token, not parse it) but trivial to decode on our side.

function encodeCursor({ created_at, id }) {
  const payload = JSON.stringify({ c: created_at, i: String(id) });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(token) {
  try {
    const json = Buffer.from(token, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj || typeof obj.c === 'undefined' || typeof obj.i === 'undefined') {
      return null;
    }
    // Validate the timestamp parses.
    const d = new Date(obj.c);
    if (Number.isNaN(d.getTime())) return null;
    return { created_at: obj.c, id: obj.i };
  } catch {
    return null;
  }
}

module.exports = { encodeCursor, decodeCursor };
