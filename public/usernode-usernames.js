/**
 * usernode-usernames.js — Global username system for Usernode dapps.
 *
 * Include after usernode-bridge.js. Provides UsernodeUsernames on window:
 *   await UsernodeUsernames.init()
 *   await UsernodeUsernames.setUsername("alice")
 *   UsernodeUsernames.getUsernameSync(pubkey)
 *
 * All dapps share one usernames address. Set your name once, every dapp
 * sees it.
 *
 * Reads come from the host server's in-memory cache served at
 * `GET /__usernames/state` — wired up via `createUsernamesCache` in
 * `examples/lib/dapp-server.js`. The host server is required: this module
 * does NOT fall back to paginating the chain itself, by design (every
 * connected client doing that doesn't scale and is the anti-pattern called
 * out in AGENTS.md Section 7).
 */
(function () {
  "use strict";

  var USERNAMES_PUBKEY =
    window.localStorage.getItem("usernode:usernames_pubkey") ||
    "ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az";

  // Per-call override for the bridge's inclusion-poll transport. The host
  // dapp page sets `window.usernode.serverCacheUrl` to its own appPubkey
  // cache (e.g. "/__usernode/cache/<lastwinPubkey>"). Without this override
  // the bridge would route the SSE waitForTx for our `set_username` send
  // at that cache — which only stores txs whose recipient is the dapp's
  // pubkey, not USERNAMES_PUBKEY. Result: the waiter never matches and
  // the bridge times out at the 180s server-side cap, even though the
  // tx confirmed on chain seconds after submission.
  //
  // Pointing at the usernames cache mount routes the waiter to the cache
  // that actually receives this tx, so confirmations come back in
  // sub-seconds via the usual node SSE → cache → /waitForTx path.
  var TX_SEND_OPTS = {
    timeoutMs: 180000,
    pollIntervalMs: 1500,
    serverCacheUrl: "/__usernode/cache/" + USERNAMES_PUBKEY,
  };
  var CACHE_TTL_MS = 30000;
  var SERVER_CACHE_URL = "/__usernames/state";

  var cache = new Map();
  var lastFetch = 0;
  var fetchPromise = null;
  var myAddress = null;

  /* ── Helpers ──────────────────────────────────────────── */

  function last6(addr) {
    return addr ? addr.slice(-6) : "";
  }

  function usernameSuffix(addr) {
    return addr ? "_" + last6(addr) : "_unknown";
  }

  function defaultUsername(addr) {
    return addr ? "user_" + last6(addr) : "user";
  }

  function normalizeUsername(raw, addr) {
    var suffix = usernameSuffix(addr);
    var maxBase = Math.max(1, 24 - suffix.length);
    var v = String(raw || "")
      .trim()
      .replace(/[^\w-]/g, "");
    if (!v) return defaultUsername(addr);
    if (v.endsWith(suffix)) v = v.slice(0, -suffix.length);
    v = v.replace(/_[A-Za-z0-9]{6}$/, "");
    return (v.slice(0, maxBase) || "user") + suffix;
  }

  /* ── Core fetch: server cache only ───────────────────── */

  function fetchUsernameTxs() {
    return fetch(SERVER_CACHE_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (!data || typeof data.usernames !== "object" || data.usernames === null) {
          return;
        }
        var pubkeys = Object.keys(data.usernames);
        for (var i = 0; i < pubkeys.length; i++) {
          var pk = pubkeys[i];
          var name = data.usernames[pk];
          if (typeof name !== "string" || !name) continue;
          // Server is the authoritative source; stamp ts as Date.now() so
          // local writes (cache.set in setUsername) can still race ahead.
          cache.set(pk, { name: name, ts: Date.now() });
        }
        lastFetch = Date.now();
      })
      .catch(function (e) {
        console.warn("UsernodeUsernames: fetch failed:", e.message || e);
      });
  }

  function ensureFresh() {
    if (Date.now() - lastFetch < CACHE_TTL_MS) return Promise.resolve();
    if (fetchPromise) return fetchPromise;
    fetchPromise = fetchUsernameTxs().then(
      function () { fetchPromise = null; },
      function () { fetchPromise = null; }
    );
    return fetchPromise;
  }

  /* ── Public API ──────────────────────────────────────── */

  window.UsernodeUsernames = {
    USERNAMES_PUBKEY: USERNAMES_PUBKEY,

    defaultUsername: defaultUsername,
    usernameSuffix: usernameSuffix,
    normalizeUsername: normalizeUsername,

    init: function () {
      return window
        .getNodeAddress()
        .then(function (addr) {
          myAddress = addr || null;
        })
        .catch(function () {})
        .then(fetchUsernameTxs);
    },

    getMyAddress: function () {
      return myAddress;
    },

    getUsername: function (pubkey) {
      return ensureFresh().then(function () {
        var entry = cache.get(pubkey);
        return entry ? entry.name : defaultUsername(pubkey);
      });
    },

    getUsernameSync: function (pubkey) {
      var entry = cache.get(pubkey);
      return entry ? entry.name : defaultUsername(pubkey);
    },

    getAllUsernamesSync: function () {
      var map = {};
      cache.forEach(function (v, k) {
        map[k] = v.name;
      });
      return map;
    },

    setUsername: function (baseName) {
      var p = myAddress
        ? Promise.resolve(myAddress)
        : window.getNodeAddress().then(function (a) {
            myAddress = a;
            return a;
          });

      return p.then(function (addr) {
        var value = normalizeUsername(baseName, addr);
        var memo = JSON.stringify({
          app: "usernames",
          type: "set_username",
          username: value,
        });
        if (memo.length > 1024) throw new Error("Username too long");
        return window
          .sendTransaction(USERNAMES_PUBKEY, 1, memo, TX_SEND_OPTS)
          .then(function () {
            cache.set(addr, { name: value, ts: Date.now() });
            return value;
          });
      });
    },

    refresh: function () {
      lastFetch = 0;
      return fetchUsernameTxs();
    },

    /**
     * Import legacy per-app usernames as fallback entries.
     * Only sets a name if no global username exists for that pubkey.
     */
    importLegacy: function (legacyMap) {
      if (!legacyMap) return;
      var entries =
        legacyMap instanceof Map
          ? Array.from(legacyMap.entries())
          : Object.entries(legacyMap);
      for (var i = 0; i < entries.length; i++) {
        var pubkey = entries[i][0];
        var name = entries[i][1];
        if (typeof name === "object" && name !== null) name = name.name;
        if (!cache.has(pubkey) && name) {
          cache.set(pubkey, { name: String(name), ts: 0 });
        }
      }
    },
  };
})();
