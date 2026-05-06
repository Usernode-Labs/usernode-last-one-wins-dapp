/**
 * Canonical txMatches predicate.
 *
 * Used in two places that MUST agree:
 *   1. createAppStateCache's SSE waitForTx route (this require()) — runs
 *      against incoming raw-txs and decides which client waiter to wake.
 *   2. usernode-bridge.js's waitForTransactionVisible polling fallback —
 *      runs against /getTransactions response items[] and decides when to
 *      resolve.
 *
 * The bridge keeps an inline copy because it has no module system and
 * dapps include it via a single <script> tag. To avoid drift the inline
 * copy carries a header pointing here. Any logic change MUST be applied
 * in both places — failure shows up as "tx confirms via polling but never
 * via SSE" (or vice versa) and is easy to spot.
 *
 * Pure function — no side effects, no I/O, no globals. Safe to call from
 * a hot loop in either runtime.
 */

function pickFirst(obj, keys) {
  for (var i = 0; i < keys.length; i++) {
    if (obj[keys[i]] != null) return obj[keys[i]];
  }
  return null;
}

function extractTxTimestampMs(tx) {
  if (!tx || typeof tx !== "object") return null;
  var candidates = [
    tx.timestamp_ms,
    tx.created_at,
    tx.createdAt,
    tx.timestamp,
    tx.time,
    tx.seen_at,
    tx.seenAt,
  ];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v < 10000000000 ? v * 1000 : v;
    }
    if (typeof v === "string" && v.trim()) {
      var t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/**
 * Returns true when `tx` (raw transaction object from chain or mock) matches
 * the `expected` predicate built by sendTransaction → waitForTransactionVisible.
 *
 * `expected` shape (all optional, all narrowing):
 *   - txId: string                — exact match against any of the tx's id fields
 *   - memo: string                — exact memo string match (null/missing tolerated)
 *   - destination_pubkey: string  — recipient match
 *   - from_pubkey: string         — sender match
 *   - minCreatedAtMs: number      — drop txs older than this (with 5s skew)
 *
 * Match is conjunctive across all set fields. txId match short-circuits true
 * — if both sides know the id, no other field has to align.
 */
function txMatches(tx, expected) {
  if (!tx || typeof tx !== "object") return false;
  if (!expected || typeof expected !== "object") return false;

  if (expected.txId) {
    var txIdCandidates = [
      tx.id, tx.txid, tx.txId, tx.tx_id, tx.hash, tx.tx_hash, tx.txHash,
    ]
      .filter(function (v) { return typeof v === "string"; })
      .map(function (v) { return v.trim(); })
      .filter(Boolean);
    if (txIdCandidates.indexOf(expected.txId) >= 0) return true;
  }

  if (typeof expected.minCreatedAtMs === "number") {
    var txTime = extractTxTimestampMs(tx);
    if (typeof txTime === "number") {
      var SKEW_MS = 5000;
      if (txTime < expected.minCreatedAtMs - SKEW_MS) return false;
    }
  }

  if (expected.memo != null) {
    var memo = tx.memo == null ? null : String(tx.memo);
    if (memo !== expected.memo) return false;
  }
  if (expected.destination_pubkey != null) {
    var raw = pickFirst(tx, ["destination_pubkey", "destination", "to"]);
    var dest = raw == null ? null : String(raw);
    if (dest !== expected.destination_pubkey) return false;
  }
  if (expected.from_pubkey != null) {
    var raw2 = pickFirst(tx, ["from_pubkey", "source", "from"]);
    var from = raw2 == null ? null : String(raw2);
    if (from !== expected.from_pubkey) return false;
  }
  return true;
}

module.exports = { txMatches, extractTxTimestampMs, pickFirst };
