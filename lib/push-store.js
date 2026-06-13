"use strict";

/**
 * Browser push subscription store.
 *
 * Keeps an in-memory Map keyed by subscription endpoint, persisted to
 * data/push_subscriptions.json so subscriptions survive server restarts.
 *
 * Call init(webPushInstance) once at startup (after webPush.setVapidDetails)
 * to enable delivery. Without init(), subscribe/unsubscribe still work but
 * sendPush is a no-op.
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STORE_FILE = path.join(DATA_DIR, "push_subscriptions.json");

// endpoint → { subscription, address, registeredAt }
const store = new Map();
let _webPush = null;

function _loadFromDisk() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    const entries = JSON.parse(raw);
    if (Array.isArray(entries)) {
      for (const [endpoint, data] of entries) {
        if (endpoint && data && data.subscription) {
          store.set(endpoint, data);
        }
      }
    }
    if (store.size > 0) console.log(`[push] Loaded ${store.size} subscription(s)`);
  } catch (_) {
    // File absent or parse error — start with empty store
  }
}

function _persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify([...store.entries()]), "utf8");
  } catch (e) {
    console.error("[push] Persist failed:", e.message);
  }
}

// Call once at startup after webPush.setVapidDetails(). Loads persisted data.
function init(webPushInstance) {
  _webPush = webPushInstance;
  _loadFromDisk();
}

// Upsert — re-subscribing the same endpoint updates the address field.
function subscribe(endpoint, subscription, address) {
  store.set(endpoint, { subscription, address: address || null, registeredAt: Date.now() });
  _persist();
}

// No-op if endpoint not found.
function unsubscribe(endpoint) {
  if (store.has(endpoint)) {
    store.delete(endpoint);
    _persist();
  }
}

function getAll() {
  return [...store.values()];
}

function getByAddress(addr) {
  if (!addr) return [];
  return [...store.values()].filter((s) => s.address === addr);
}

// Fire-and-forget. Removes expired/revoked subscriptions (404/410) silently.
// No-op when init() has not been called.
async function sendPush(subscriptions, payload) {
  if (!_webPush || !subscriptions || subscriptions.length === 0) return;
  const data = JSON.stringify(payload);
  for (const entry of subscriptions) {
    try {
      await _webPush.sendNotification(entry.subscription, data);
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        console.log(`[push] Removing expired subscription`);
        unsubscribe(entry.subscription.endpoint);
      } else {
        console.warn("[push] Delivery failed:", e.statusCode || e.message);
      }
    }
  }
}

module.exports = { init, subscribe, unsubscribe, getAll, getByAddress, sendPush };
