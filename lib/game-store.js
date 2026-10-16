"use strict";

/**
 * Postgres persistence for the lastwin game state.
 *
 * Saves a JSON snapshot of the game (round number, pot, past rounds, streaks,
 * wins, seen tx ids) so an update/restart continues from where the previous
 * process left off instead of rebuilding from the chain, which can come out
 * short (see issue #19).
 *
 * Styled after lib/push-store.js: init() once at startup, then writes are
 * fire-and-forget (1s debounce, one write in flight at a time). No-op unless
 * DATABASE_URL is set and init() succeeded — local-dev and any environment
 * without a database behave exactly as before.
 *
 * The table carries a 'staging:private' comment so staging previews get
 * their own empty copy: staging demo progress never mixes with production.
 */

const TABLE = "lastwin_state";

let pool = null;
let enabled = false;
let appPubkey = null;
let chainId = null;

let saveTimer = null;
let saving = false;
let dirty = false;
let pendingSnapshotGetter = null;
let saveChain = Promise.resolve();

function isConfigured() {
  return !!process.env.DATABASE_URL;
}

// Call once at startup before load(). Creates the table if needed.
// Returns false (and stays disabled) when DATABASE_URL is unset or pg
// cannot be loaded — the caller then falls back to the chain rebuild.
async function init(key) {
  appPubkey = key || null;
  if (!process.env.DATABASE_URL) {
    console.log("[game-store] DATABASE_URL unset — state persistence off");
    return false;
  }
  let Pool;
  try { ({ Pool } = require("pg")); }
  catch (e) {
    console.error("[game-store] pg not available — state persistence off:", e.message);
    return false;
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      app_pubkey  TEXT PRIMARY KEY,
      chain_id    TEXT,
      data        JSONB NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`COMMENT ON TABLE ${TABLE} IS 'staging:private'`);
  enabled = true;
  console.log("[game-store] state persistence ready");
  return true;
}

// Latest saved snapshot for this app, or null when none exists.
// Throws on query failure — the caller treats that as "do not overwrite".
async function load(key) {
  if (!pool) return null;
  const res = await pool.query(
    `SELECT chain_id, data FROM ${TABLE} WHERE app_pubkey = $1`,
    [key],
  );
  if (res.rows.length === 0) return null;
  return { chainId: res.rows[0].chain_id || null, data: res.rows[0].data };
}

function setChainId(id) {
  chainId = id || null;
}

// Debounced save: getSnapshot() is invoked at write time so it sees the
// freshest state. Multiple calls inside the debounce window collapse into
// one write; while a write is in flight further changes re-queue after it.
function scheduleSave(getSnapshot) {
  if (!enabled) return;
  pendingSnapshotGetter = getSnapshot;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    pump();
  }, 1000);
}

// Write any pending snapshot now (and wait for an in-flight write).
async function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    pump();
  }
  await saveChain;
}

async function close() {
  await flush();
  if (pool) await pool.end();
  pool = null;
  enabled = false;
}

function pump() {
  if (!enabled || !pendingSnapshotGetter) return;
  if (saving) { dirty = true; return; }
  saving = true;
  saveChain = saveChain.then(async () => {
    try {
      while (pendingSnapshotGetter) {
        const get = pendingSnapshotGetter;
        pendingSnapshotGetter = null;
        try {
          const snapshot = get();
          await pool.query(
            `INSERT INTO ${TABLE} (app_pubkey, chain_id, data, updated_at)
             VALUES ($1, $2, $3, now())
             ON CONFLICT (app_pubkey) DO UPDATE
             SET chain_id = EXCLUDED.chain_id,
                 data = EXCLUDED.data,
                 updated_at = now()`,
            [appPubkey, chainId, JSON.stringify(snapshot)],
          );
        } catch (e) {
          // Logged and dropped; the next state change retries.
          console.error("[game-store] save failed:", e.message);
          break;
        }
      }
    } finally {
      saving = false;
      if (dirty) {
        dirty = false;
        pump();
      }
    }
  });
  return saveChain;
}

module.exports = { init, load, setChainId, scheduleSave, flush, close, isConfigured };
