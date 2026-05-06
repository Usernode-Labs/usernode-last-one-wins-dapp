/**
 * Shared server utilities for Usernode dapps.
 *
 * Provides: JSON body parsing, HTTPS fetch, explorer proxy, mock transaction
 * API, chain poller, and path resolution. Used by both the combined examples
 * server and standalone sub-app servers.
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { txMatches } = require("./tx-match");

// ── .env loader ─────────────────────────────────────────────────────────────
// Loads KEY=VALUE pairs from a .env file into process.env (does not overwrite
// existing env vars). Zero dependencies.

function loadEnvFile(filePath) {
  if (!filePath) {
    const candidates = [
      path.resolve(process.cwd(), ".env"),
      path.resolve(__dirname, "..", "..", ".env"),
    ];
    filePath = candidates.find((p) => fs.existsSync(p));
  }
  if (!filePath || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = val;
  }
}

// Returns the list of explorer upstream hosts in preferred order. The
// canonical public testnet explorer is a single host; setting
// EXPLORER_UPSTREAMS lets you point at multiple alternates (e.g. a
// localnet block explorer for offline dev, or a future multi-host setup).
//
// Configuration precedence:
//   1. EXPLORER_UPSTREAMS  — comma-separated list, e.g.
//                            "testnet-explorer.usernodelabs.org,backup.example.org"
//   2. EXPLORER_UPSTREAM   — single-host (legacy); used as a 1-element list
//   3. Default fallback list: [testnet-explorer.usernodelabs.org].
function getExplorerUpstreams() {
  const list = process.env.EXPLORER_UPSTREAMS;
  if (typeof list === "string" && list.trim()) {
    return list.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const single = process.env.EXPLORER_UPSTREAM;
  if (typeof single === "string" && single.trim()) {
    return [single.trim()];
  }
  return ["testnet-explorer.usernodelabs.org"];
}

// Shared host-health table. Updated by the node-status probe (canonical
// source) and, on connect failure, by the proxy. Read by the proxy and
// chain pollers to pick a healthy host.
//
// Empty / no entry for a host = "haven't probed yet, optimistically use".
// Entry with status === "ok" = "use this one."
// Entry with any other status = "skip if there's a healthier alternative."
const _explorerHostHealth = new Map();

function setExplorerUpstreamHealth(host, info) {
  if (!host) return;
  _explorerHostHealth.set(host, info);
}

function getExplorerHostHealth(host) {
  return _explorerHostHealth.get(host) || null;
}

// Picks the first host whose latest probe is `ok` (or never been probed,
// optimistic). Falls back to the first configured host if every host has
// been probed and none is ok — the caller still attempts a request, since
// the host could be transiently down between probe ticks.
function pickActiveExplorerUpstream() {
  const hosts = getExplorerUpstreams();
  for (const host of hosts) {
    const info = _explorerHostHealth.get(host);
    if (!info) return host;          // never probed → primary wins
    if (info.status === "ok") return host;
  }
  return hosts[0];
}

// Returns the configured host list ordered by health: every "ok" host
// first (in configured order), then every other host. Used by the proxy
// fallback walker so we always try the most likely-healthy host first.
function orderedExplorerUpstreams() {
  const hosts = getExplorerUpstreams();
  const ok = [], rest = [];
  for (const host of hosts) {
    const info = _explorerHostHealth.get(host);
    if (!info || info.status === "ok") ok.push(host);
    else rest.push(host);
  }
  return ok.concat(rest);
}

// Backwards-compat alias: previously this was a hard-coded single host.
// Now returns whichever configured host the probe says is currently
// healthy. Existing callers (`opts.upstream || getExplorerUpstream()`)
// continue to work and silently gain fallback support.
function getExplorerUpstream() {
  return pickActiveExplorerUpstream();
}

function getExplorerUpstreamBase() {
  return process.env.EXPLORER_UPSTREAM_BASE != null
    ? process.env.EXPLORER_UPSTREAM_BASE
    : "/api";
}

// ── JSON body parser ─────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
  });
}

// ── Protocol helper ──────────────────────────────────────────────────────────

function explorerProto(host) {
  return /^(localhost|127\.|192\.|10\.|172\.)/.test(host) ? "http" : "https";
}

function explorerTransport(host) {
  return explorerProto(host) === "https" ? https : http;
}

// ── JSON requester ───────────────────────────────────────────────────────────

function httpsJson(method, urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === "https:" ? https : http;
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = transport.request(url, {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// Multi-host explorer JSON requester. The canonical "talk to the
// explorer" entrypoint for everything in this file (chain poller,
// backfill, discovery, genesis-account scan). Walks
// `orderedExplorerUpstreams()` (probe-healthy hosts first) on every
// call, trying each host in sequence. On a connect/HTTP failure we
// downgrade that host's entry in `_explorerHostHealth` so subsequent
// calls skip it until the probe re-validates; on success we don't
// touch health (the probe owns the canonical view — overwriting here
// would lose chainId/latency).
//
//   pathFromHost(host) → string
//     Builds the URL for `host`. Most callers use:
//       (h) => `${explorerProto(h)}://${h}${base}/active_chain`
//     so http/https selection still works per-host.
//
//   opts.explicitUpstream
//     If set, pin to that one host (no fallback). Honors
//     `opts.upstream` overrides plumbed through from outer callers
//     who explicitly want single-host behavior (e.g. tests).
//
// Throws after exhausting all hosts. Caller decides whether to swallow
// (e.g. discoverChainId logs and returns null) or propagate.
async function httpsJsonExplorer(method, pathFromHost, body, opts) {
  const explicitUpstream = opts && opts.explicitUpstream;
  const hosts = explicitUpstream ? [explicitUpstream] : orderedExplorerUpstreams();
  if (!hosts.length) throw new Error("No explorer hosts configured");

  const errors = [];
  for (const host of hosts) {
    const url = pathFromHost(host);
    try {
      return await httpsJson(method, url, body);
    } catch (e) {
      const errMsg = e && e.message ? e.message : String(e);
      errors.push(`${host}: ${errMsg}`);
      setExplorerUpstreamHealth(host, {
        host,
        status: "unreachable",
        chainId: null,
        latencyMs: null,
        error: errMsg,
        at: Date.now(),
      });
    }
  }
  throw new Error(`All explorer hosts failed: ${errors.join("; ")}`);
}

// ── Explorer API proxy ───────────────────────────────────────────────────────
//
// Returns true if the request was handled (pathname starts with /explorer-api/).
//
// Multi-host fallback: when no explicit `opts.upstream` is provided, the
// proxy walks `orderedExplorerUpstreams()` (probe-healthy hosts first) and
// retries the next host on a pre-response connect error. Once a host
// returns headers we commit to it for that response. Connect failures
// downgrade the host's health entry so subsequent requests skip it
// without retrying — the next probe tick will bring it back if it
// recovers. If every configured host fails, we return 502 with a list
// of per-host errors (matches the existing behavior, just enumerated).

function handleExplorerProxy(req, res, pathname, opts) {
  const prefix = "/explorer-api/";
  if (!pathname.startsWith(prefix)) return false;

  const explicitUpstream = opts && opts.upstream;
  const upstreamBase = (opts && opts.upstreamBase) || getExplorerUpstreamBase();
  const upstreamPath = upstreamBase + "/" + pathname.slice(prefix.length);

  // Honor an explicit upstream (caller is overriding fallback on purpose,
  // e.g. for testing). Otherwise try every configured host in
  // health-aware order.
  const upstreams = explicitUpstream ? [explicitUpstream] : orderedExplorerUpstreams();

  void (async () => {
    let bodyBuf = null;
    if (req.method === "POST") {
      try {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (chunks.reduce((s, c) => s + c.length, 0) > 1_000_000) {
            if (!res.headersSent) {
              res.writeHead(413, { "Content-Type": "text/plain" });
              res.end("Body too large");
            }
            return;
          }
        }
        bodyBuf = Buffer.concat(chunks);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
        }
        return;
      }
    }

    const errors = [];
    for (const upstream of upstreams) {
      const proto = explorerProto(upstream);
      const upstreamUrl = new URL(`${proto}://${upstream}${upstreamPath}`);

      // Each iteration: succeed (resolves true, response already piped)
      // or fail at connect (resolves false, we move on to the next host).
      const succeeded = await new Promise((resolve) => {
        let settled = false;
        const proxyReq = explorerTransport(upstream).request(upstreamUrl, {
          method: req.method,
          headers: {
            "content-type": req.headers["content-type"] || "application/json",
            accept: "application/json",
            ...(bodyBuf ? { "content-length": bodyBuf.length } : {}),
          },
        }, (proxyRes) => {
          settled = true;
          // We have headers — committed to this host. Pipe and resolve
          // when the body completes (or errors mid-stream, in which case
          // there's nothing useful to do besides closing the response).
          res.writeHead(proxyRes.statusCode || 502, {
            "content-type": proxyRes.headers["content-type"] || "application/json",
            "access-control-allow-origin": "*",
          });
          proxyRes.pipe(res);
          proxyRes.on("end", () => resolve(true));
          proxyRes.on("error", () => resolve(true));
        });
        proxyReq.on("error", (err) => {
          if (settled) return; // already responded; ignore late socket noise
          settled = true;
          errors.push(`${upstream}: ${err.message}`);
          // Downgrade health so the next request skips this host until
          // the probe reverifies. We don't upgrade on success because
          // the probe owns the canonical health view and we'd lose
          // chainId/latency by overwriting here.
          setExplorerUpstreamHealth(upstream, {
            host: upstream,
            status: "unreachable",
            chainId: null,
            latencyMs: null,
            error: err.message,
            at: Date.now(),
          });
          resolve(false);
        });
        if (bodyBuf) proxyReq.write(bodyBuf);
        proxyReq.end();
      });

      if (succeeded) return;
    }

    // Every host failed before producing a response.
    if (!res.headersSent) {
      const msg = errors.length
        ? `All explorer hosts unreachable: ${errors.join("; ")}`
        : "No explorer hosts configured";
      console.error(`[explorer-proxy] ${msg}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg, hosts: errors }));
    }
  })();

  return true;
}

// ── Mock transaction API ─────────────────────────────────────────────────────
//
// Returns { transactions, handleRequest }.
// handleRequest(req, res, pathname) returns true if handled.

function createMockApi(opts) {
  const localDev = (opts && opts.localDev) || false;
  const delayMs = (opts && opts.delayMs) || 5000;
  const delayOverrides = (opts && opts.delayOverrides) || {};
  const transactions = [];

  function handleRequest(req, res, pathname) {
    if (pathname === "/__mock/enabled") {
      if (!localDev) {
        res.writeHead(404); res.end("Not found");
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ enabled: true }));
      return true;
    }

    if (pathname === "/__mock/sendTransaction" && req.method === "POST") {
      if (!localDev) {
        res.writeHead(404); res.end("Not found (start with --local-dev)");
        return true;
      }
      readJson(req).then((body) => {
        const from_pubkey = String(body.from_pubkey || "").trim();
        const destination_pubkey = String(body.destination_pubkey || "").trim();
        const amount = body.amount;
        const memo = body.memo == null ? undefined : String(body.memo);
        if (!from_pubkey || !destination_pubkey) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "from_pubkey and destination_pubkey required" }));
          return;
        }
        console.log(`[tx] received from=${from_pubkey.slice(0, 16)}… dest=${destination_pubkey.slice(0, 16)}…`);
        const tx = { id: crypto.randomUUID(), from_pubkey, destination_pubkey, amount, memo, created_at: new Date().toISOString() };
        const txDelay = (destination_pubkey in delayOverrides) ? delayOverrides[destination_pubkey] : delayMs;
        setTimeout(() => { transactions.push(tx); }, txDelay);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ queued: true, tx }));
      }).catch((e) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return true;
    }

    if (pathname === "/__mock/getTransactions" && req.method === "POST") {
      if (!localDev) {
        res.writeHead(404); res.end("Not found (start with --local-dev)");
        return true;
      }
      readJson(req).then((body) => {
        const filterOptions = body.filterOptions || {};
        const owner = String(body.owner_pubkey || filterOptions.account || "").trim();
        const limit = typeof filterOptions.limit === "number" ? filterOptions.limit : 50;
        const cursor = filterOptions.cursor || body.cursor || null;

        const filtered = transactions
          .filter((tx) => !owner || tx.from_pubkey === owner || tx.destination_pubkey === owner);

        // Cursor is a 0-based index into the filtered array (descending).
        // Reverse so newest is first (index 0 = newest).
        const reversed = filtered.slice().reverse();
        let startIdx = 0;
        if (cursor != null) {
          try {
            startIdx = parseInt(Buffer.from(String(cursor), "base64").toString("utf8"), 10);
            if (!Number.isFinite(startIdx) || startIdx < 0) startIdx = 0;
          } catch (_) { startIdx = 0; }
        }

        const page = reversed.slice(startIdx, startIdx + limit);
        const nextIdx = startIdx + limit;
        const hasMore = nextIdx < reversed.length;
        const nextCursor = hasMore
          ? Buffer.from(String(nextIdx)).toString("base64")
          : null;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          items: page,
          has_more: hasMore,
          next_cursor: nextCursor,
        }));
      }).catch((e) => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      });
      return true;
    }

    return false;
  }

  return { transactions, handleRequest };
}

// ── Confirmation status ──────────────────────────────────────────────────────

function isExplorerConfirmed(status) {
  return status === "confirmed" || status === "canonical";
}

// ── Chain poller ─────────────────────────────────────────────────────────────
//
// Polls the explorer API for new transactions and calls onTransaction(tx) for
// each unseen one. Returns { start() }.

function createChainPoller(opts) {
  const appPubkey = opts.appPubkey;
  const onTransaction = opts.onTransaction;
  const onChainReset = opts.onChainReset || null;
  const intervalMs = opts.intervalMs || 3000;
  // `explicitUpstream` honors callers that explicitly pin to one host
  // (tests, single-host overrides). When unset (the default), each
  // request resolves the active host fresh via httpsJsonExplorer →
  // orderedExplorerUpstreams(), so a poller booted before the probe
  // populated health no longer freezes onto a dead host forever.
  const explicitUpstream = opts.upstream || null;
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const queryField = opts.queryField || "account";
  const maxPages = opts.maxPages || 200;
  const seenIdsCap = opts.seenIdsCap || 5000;
  const recheckIntervalPolls = opts.recheckIntervalPolls || 10;
  const skipOrphaned = opts.skipOrphaned !== false;

  let chainId = null;
  const seenTxIds = new Set();
  let lastHeight = (opts.initialLastHeight != null) ? opts.initialLastHeight : null;
  let pollCount = 0;

  async function fetchActiveChainId() {
    const data = await httpsJsonExplorer(
      "GET",
      (h) => `${explorerProto(h)}://${h}${upstreamBase}/active_chain`,
      null,
      { explicitUpstream },
    );
    return (data && data.chain_id) ? data.chain_id : null;
  }

  async function discoverChainId() {
    try {
      const id = await fetchActiveChainId();
      if (id) {
        chainId = id;
        console.log(`[chain] discovered chain_id: ${chainId}`);
      }
    } catch (e) {
      console.warn(`[chain] could not discover chain ID: ${e.message}`);
    }
  }

  async function recheckChainId() {
    try {
      const id = await fetchActiveChainId();
      if (id && id !== chainId) {
        const oldId = chainId;
        console.log(`[chain] chain_id changed: ${oldId} -> ${id} — resetting poller state`);
        chainId = id;
        seenTxIds.clear();
        lastHeight = null;
        if (onChainReset) onChainReset(id, oldId);
      }
    } catch (e) {
      // Transient error — keep using current chainId
    }
  }

  function extractTxTimestamp(tx) {
    const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
    for (const v of candidates) {
      if (typeof v === "number" && Number.isFinite(v))
        return v < 10_000_000_000 ? v * 1000 : v;
      if (typeof v === "string" && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return 0;
  }

  async function poll() {
    if (!chainId) { await discoverChainId(); if (!chainId) return; }
    else if (pollCount > 0 && pollCount % recheckIntervalPolls === 0) {
      await recheckChainId();
    }

    pollCount++;
    const MAX_PAGES = maxPages;
    let cursor = null, totalItems = 0;
    const newTxs = [];
    const fromHeight = lastHeight;
    let maxHeight = lastHeight;

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = { [queryField]: appPubkey, limit: 50 };
        if (cursor) body.cursor = cursor;
        if (fromHeight != null) body.from_height = fromHeight;
        const resp = await httpsJsonExplorer(
          "POST",
          (h) => `${explorerProto(h)}://${h}${upstreamBase}/${chainId}/transactions`,
          body,
          { explicitUpstream },
        );

        if (pollCount <= 2 && page === 0) {
          const keys = resp ? Object.keys(resp) : [];
          const firstItem = resp && resp.items && resp.items[0]
            ? JSON.stringify(resp.items[0]).slice(0, 200) : "none";
          console.log(`[chain] poll #${pollCount} keys=[${keys}] first=${firstItem}`);
        }

        const items = Array.isArray(resp) ? resp
          : (resp && Array.isArray(resp.items)) ? resp.items
          : (resp && Array.isArray(resp.transactions)) ? resp.transactions
          : (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items
          : [];

        if (items.length === 0) break;
        totalItems += items.length;

        let allSeen = true;
        for (const tx of items) {
          const txId = tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash;
          if (!txId) continue;
          if (seenTxIds.has(txId)) continue;
          if (skipOrphaned && tx.status && !isExplorerConfirmed(tx.status)) continue;
          allSeen = false;
          seenTxIds.add(txId);
          newTxs.push(tx);

          const bh = tx.block_height;
          if (typeof bh === "number" && (maxHeight == null || bh > maxHeight)) {
            maxHeight = bh;
          }
        }

        if (allSeen) break;
        const hasMore = resp && resp.has_more;
        const nextCursor = resp && resp.next_cursor;
        if (!hasMore || !nextCursor) break;
        cursor = nextCursor;
      }

      if (maxHeight != null) lastHeight = maxHeight;

      // Bound seenTxIds to prevent unbounded memory growth.
      if (seenTxIds.size > seenIdsCap) {
        const arr = Array.from(seenTxIds);
        seenTxIds.clear();
        for (let i = arr.length - seenIdsCap; i < arr.length; i++) {
          seenTxIds.add(arr[i]);
        }
      }

      // Process in chronological order so stateful consumers (game logic,
      // vote resolution) see events oldest-first.
      newTxs.sort((a, b) => extractTxTimestamp(a) - extractTxTimestamp(b));
      for (const tx of newTxs) {
        if (onTransaction) onTransaction(tx);
      }

      if (newTxs.length > 0 || pollCount <= 3) {
        console.log(`[chain] poll #${pollCount}: ${totalItems} tx(s) scanned, ${newTxs.length} new (lastHeight=${lastHeight ?? "none"})`);
      }
    } catch (e) {
      console.warn(`[chain] poll #${pollCount} error: ${e.message}`);
    }
  }

  function setInitialLastHeight(h) {
    if (lastHeight == null && h != null) lastHeight = h;
  }

  function addSeenIds(ids) {
    for (const id of ids) if (id) seenTxIds.add(id);
  }

  function start() {
    poll();
    setInterval(poll, intervalMs);
  }

  return { start, setInitialLastHeight, addSeenIds };
}

// ── Node RPC: tracked-owner registration + recent-tx-by-recipient ──────────
//
// Direct-to-node fast path for the `recipient` queryField. Lets dapp servers
// bypass explorer indexing lag (5–60s observed) by reading newly-applied
// transactions out of the node's per-tracked-owner ring buffer instead.
// See `usernode/docs/reference/rpc.md` for endpoint shapes.

async function walletAddTrackedOwner(opts) {
  const nodeRpcUrl = opts && opts.nodeRpcUrl;
  const owner = opts && opts.owner;
  if (!nodeRpcUrl || !owner) {
    throw new Error("walletAddTrackedOwner: nodeRpcUrl and owner required");
  }
  return httpsJson("POST", `${nodeRpcUrl}/wallet/tracked_owner/add`, { owner });
}

async function nodeRecentTxByRecipient(opts) {
  const nodeRpcUrl = opts.nodeRpcUrl;
  const recipient = opts.recipient;
  if (!nodeRpcUrl || !recipient) {
    throw new Error("nodeRecentTxByRecipient: nodeRpcUrl and recipient required");
  }
  const body = { recipient };
  if (opts.sinceHeight != null) body.since_height = opts.sinceHeight;
  if (opts.limit != null) body.limit = opts.limit;
  return httpsJson("POST", `${nodeRpcUrl}/transactions/by_recipient`, body);
}

// ── Memo decoder (node wire format → dapp-friendly UTF-8 string) ───────────
//
// The node serializes `Memo` as base64url-encoded bytes (per its
// human-readable serde — see `crates/core/src/transaction/memo.rs`). The
// explorer returns the raw memo string. Dapps' `parseMemo` helpers expect
// the explorer shape, so we decode at the boundary.

function _base64urlDecodeUtf8(s) {
  if (s == null) return "";
  const str = String(s);
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  try {
    return Buffer.from(padded + "=".repeat(padLen), "base64").toString("utf8");
  } catch (_) {
    return "";
  }
}

// Convert a `RecentTxEntry` (node wire format) to the explorer-compatible
// shape that `processTransaction` expects everywhere else in the dapp stack.
function _nodeEntryToExplorerShape(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    tx_id: entry.tx_id,
    source: entry.source != null ? entry.source : null,
    destination: entry.recipient,
    amount: typeof entry.amount === "string" ? Number(entry.amount) : entry.amount,
    memo: _base64urlDecodeUtf8(entry.memo),
    block_hash: entry.block_hash,
    block_height: entry.block_height,
    timestamp_ms: entry.block_timestamp_ms,
    status: "confirmed",
    tx_type: "transfer",
  };
}

// ── Node SSE client (live recent-tx stream) ─────────────────────────────────
//
// Connects to `GET /transactions/stream?recipient=…`. Each frame is a
// `data: {JSON RecentTxEntry}\n\n` block; comments (lines starting with `:`)
// and other SSE fields are ignored. Returns { close() }.
//
// Caller handles reconnect — this function just returns when the connection
// drops (via `onClose`).

function _streamNodeSse(opts) {
  const nodeRpcUrl = opts.nodeRpcUrl;
  const recipient = opts.recipient;
  const onEvent = opts.onEvent;
  const onClose = opts.onClose;
  // Fired exactly once when the upstream returns 200 — i.e. the SSE
  // connection is actually live and ready to deliver events. Used by
  // callers to track per-stream readiness for the node-status probe.
  const onOpen = typeof opts.onOpen === "function" ? opts.onOpen : null;
  const url = new URL(`${nodeRpcUrl}/transactions/stream`);
  url.searchParams.set("recipient", recipient);
  const transport = url.protocol === "https:" ? https : http;

  let closed = false;
  function safeClose(err) {
    if (closed) return;
    closed = true;
    try { onClose(err || null); } catch (_) {}
  }

  const req = transport.request(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream",
      "cache-control": "no-store",
    },
    // Disable timeout — SSE is long-lived. Heartbeat is the underlying
    // transport's keep-alive; the server emits `:keep-alive` comments via
    // axum's `KeepAlive::default()` (15s).
    timeout: 0,
  }, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      safeClose(new Error(`SSE HTTP ${res.statusCode}`));
      return;
    }
    if (onOpen) {
      try { onOpen(); } catch (_) {}
    }
    res.setEncoding("utf8");
    let buf = "";
    res.on("data", (chunk) => {
      buf += chunk;
      let idx;
      // SSE event boundary is a blank line (\n\n). Tolerate \r\n endings too.
      while ((idx = buf.search(/\n\n|\r\n\r\n/)) !== -1) {
        const sep = buf[idx] === "\r" ? 4 : 2;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + sep);
        const dataLines = [];
        for (const rawLine of frame.split(/\r?\n/)) {
          if (rawLine.startsWith(":")) continue; // comment / keep-alive
          if (rawLine.startsWith("data:")) {
            dataLines.push(rawLine.slice(5).replace(/^ /, ""));
          }
          // Other SSE fields (event:, id:, retry:) ignored.
        }
        if (!dataLines.length) continue;
        const data = dataLines.join("\n");
        try {
          const parsed = JSON.parse(data);
          onEvent(parsed);
        } catch (_) {
          // Tolerate malformed frames; SSE is best-effort and the
          // catch-up poll will pick up anything we drop.
        }
      }
    });
    res.on("end", () => safeClose(null));
    res.on("error", (err) => safeClose(err));
    res.on("aborted", () => safeClose(new Error("SSE response aborted")));
  });
  req.on("error", (err) => safeClose(err));
  req.on("timeout", () => safeClose(new Error("SSE request timeout")));
  req.end();

  return {
    close() {
      if (!closed) req.destroy();
      safeClose(null);
    },
  };
}

// ── Live recent-tx stream from the node (SSE + catch-up poll) ───────────────
//
// Replaces `createChainPoller` for the `recipient` queryField when a
// `nodeRpcUrl` is available. Drives `onTransaction(tx)` with the same
// explorer-shape transaction objects the rest of the dapp pipeline expects.
//
// Reliability strategy:
//   - Bootstrap on every (re)connect: poll `POST /transactions/by_recipient`
//     with `since_height: lastHeight + 1` to fill the gap between the
//     explorer-driven backfill (or previous SSE session) and now.
//   - Subscribe to `GET /transactions/stream` and dispatch each frame.
//   - On any stream error/close, exponential-backoff and reconnect — the
//     next bootstrap-poll catches anything missed during the gap.
//   - Periodic safety-net poll (every `catchupIntervalMs`, default 30s) to
//     paper over silently-broken streams (e.g. proxies that hold the
//     connection open without delivering data).
//
// Returns { start, setInitialLastHeight, addSeenIds, close }.

function createNodeRecentTxStream(opts) {
  const nodeRpcUrl = opts.nodeRpcUrl;
  const recipient = opts.recipient;
  const onTransaction = opts.onTransaction;
  const onChainReset = opts.onChainReset || null;
  const name = opts.name || (recipient ? recipient.slice(0, 12) + "…" : "node-stream");
  const catchupIntervalMs = opts.catchupIntervalMs || 30000;
  const seenIdsCap = opts.seenIdsCap || 5000;
  const initialBackoffMs = opts.initialBackoffMs || 1000;
  const maxBackoffMs = opts.maxBackoffMs || 30000;
  const ensureTrackedOwner = opts.ensureTrackedOwner !== false;

  if (!nodeRpcUrl) throw new Error("createNodeRecentTxStream: nodeRpcUrl required");
  if (!recipient) throw new Error("createNodeRecentTxStream: recipient required");
  if (typeof onTransaction !== "function") {
    throw new Error("createNodeRecentTxStream: onTransaction required");
  }

  let lastHeight = (opts.initialLastHeight != null) ? opts.initialLastHeight : null;
  const seenTxIds = new Set();
  let stream = null;
  let stopped = false;
  let backoffMs = initialBackoffMs;
  let trackedOwnerEnsured = !ensureTrackedOwner;
  let catchupTimer = null;

  // Readiness model: the stream is "ready" when the SSE socket is open
  // *and* the node is tracking this recipient. Either condition flipping
  // false means we may silently miss events until the next reconnect, so
  // we surface this to the node-status probe (which the dapp-loading
  // overlay reads) to keep the UI gated until we're truly live.
  let sseOpen = false;
  let lastReady = false;
  const readyListeners = new Set();
  function isReady() {
    return trackedOwnerEnsured && sseOpen;
  }
  function fireReadyIfChanged() {
    const r = isReady();
    if (r === lastReady) return;
    lastReady = r;
    for (const cb of readyListeners) {
      try { cb(r); } catch (_) {}
    }
  }
  function onReadyChange(cb) {
    if (typeof cb !== "function") return () => {};
    readyListeners.add(cb);
    return () => { readyListeners.delete(cb); };
  }

  function trimSeenIds() {
    if (seenTxIds.size <= seenIdsCap) return;
    const arr = Array.from(seenTxIds);
    seenTxIds.clear();
    for (let i = arr.length - seenIdsCap; i < arr.length; i++) {
      seenTxIds.add(arr[i]);
    }
  }

  function dispatchEntry(entry) {
    if (!entry || !entry.tx_id) return;
    if (seenTxIds.has(entry.tx_id)) return;
    seenTxIds.add(entry.tx_id);
    if (typeof entry.block_height === "number") {
      if (lastHeight == null || entry.block_height > lastHeight) {
        lastHeight = entry.block_height;
      }
    }
    const tx = _nodeEntryToExplorerShape(entry);
    if (tx) onTransaction(tx);
  }

  async function ensureTracked() {
    if (trackedOwnerEnsured) return;
    try {
      await walletAddTrackedOwner({ nodeRpcUrl, owner: recipient });
      trackedOwnerEnsured = true;
      console.log(`[${name}] tracked-owner registered with node`);
      fireReadyIfChanged();
    } catch (e) {
      // Non-fatal: the SSE will simply yield no events until tracking is
      // established. Surface to logs and let the reconnect loop retry.
      console.warn(`[${name}] tracked_owner/add failed: ${e.message}`);
    }
  }

  async function catchup() {
    try {
      // Self-heal stuck startup races + mid-session sidecar wipes.
      //
      // Without this retry, any failure of the connect()-time
      // ensureTracked() call (sidecar still booting, transient 5xx,
      // ECONNREFUSED race against compose ordering) leaves us pinned in
      // `sseOpen=true, trackedOwnerEnsured=false` forever: the SSE
      // socket goes up cleanly a moment later, demotion in the
      // tracked:false branch below is a no-op (already false), and
      // there's no other code path that re-POSTs /wallet/tracked_owner/add
      // until the SSE socket closes — which never happens on its own.
      // The visible symptom is the dapp-loading overlay hanging at
      // "Connecting to live updates… almost ready" indefinitely because
      // streamGateOk(streamKey) keeps reading streamReady=false.
      //
      // ensureTracked() short-circuits when already true, so this is
      // free in the common case.
      if (ensureTrackedOwner && !trackedOwnerEnsured) {
        await ensureTracked();
      }

      const since = lastHeight != null ? lastHeight : undefined;
      const resp = await nodeRecentTxByRecipient({
        nodeRpcUrl,
        recipient,
        sinceHeight: since,
      });
      if (!resp || !Array.isArray(resp.items)) return;
      if (resp.tracked === false && ensureTrackedOwner) {
        // The sidecar lost our registration (deploy/restart that survived
        // our SSE socket via HTTP keepalive, manual eviction, etc.).
        // Demote so the loader's stream gate flips to "not ready", then
        // the next catchup tick (~30s) re-runs ensureTracked() above.
        trackedOwnerEnsured = false;
        fireReadyIfChanged();
      }
      // Sort oldest-first as a defensive measure (the endpoint already
      // guarantees this, but downstream consumers expect chronological).
      const items = resp.items.slice().sort(
        (a, b) => (a.block_height || 0) - (b.block_height || 0)
      );
      for (const entry of items) dispatchEntry(entry);
      trimSeenIds();
    } catch (e) {
      // Surface but don't escalate; the next tick will retry.
      console.warn(`[${name}] catchup failed: ${e.message}`);
    }
  }

  async function connect() {
    if (stopped) return;

    await ensureTracked();
    await catchup();

    if (stopped) return;

    stream = _streamNodeSse({
      nodeRpcUrl,
      recipient,
      onOpen: () => {
        sseOpen = true;
        // Reset the reconnect backoff the moment the socket comes up,
        // not on first event — quiet streams (no recipient activity)
        // shouldn't be punished with longer backoffs after a hiccup.
        backoffMs = initialBackoffMs;
        fireReadyIfChanged();
      },
      onEvent: (entry) => {
        dispatchEntry(entry);
        trimSeenIds();
      },
      onClose: (err) => {
        stream = null;
        sseOpen = false;
        fireReadyIfChanged();
        if (stopped) return;
        if (err) {
          console.warn(`[${name}] SSE closed: ${err.message}; reconnecting in ${backoffMs}ms`);
        }
        const wait = backoffMs;
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
        setTimeout(() => { if (!stopped) connect(); }, wait);
      },
    });
  }

  function start() {
    if (stopped) return;
    void connect();
    if (catchupTimer == null) {
      catchupTimer = setInterval(() => { void catchup(); }, catchupIntervalMs);
    }
  }

  function close() {
    stopped = true;
    if (catchupTimer != null) {
      clearInterval(catchupTimer);
      catchupTimer = null;
    }
    if (stream) {
      try { stream.close(); } catch (_) {}
      stream = null;
    }
  }

  function setInitialLastHeight(h) {
    if (lastHeight == null && h != null) lastHeight = h;
  }

  function addSeenIds(ids) {
    if (!Array.isArray(ids)) return;
    for (const id of ids) if (id) seenTxIds.add(id);
    trimSeenIds();
  }

  // Stub for parity with `createChainPoller`'s onChainReset semantics. The
  // node-side ring buffer doesn't need explicit reset notifications — when
  // the node restarts on a new chain, the catch-up poll sees `tracked: false`
  // (we re-register) and `latest_block_height: null` (height resets), and
  // `onChainReset` is fired by the parallel explorer poller (or the cache
  // wrapper) anyway.
  void onChainReset;

  function getStats() {
    return {
      sseOpen,
      trackedOwnerEnsured,
      lastHeight,
      backoffMs,
    };
  }

  return { start, close, setInitialLastHeight, addSeenIds, isReady, onReadyChange, getStats };
}

// ── Bulk transaction fetch ───────────────────────────────────────────────────
//
// One-shot paginated fetch of all transactions for a pubkey/chain.
// Returns { transactions: [...], lastHeight, txIds: [...] } sorted oldest-first.

async function fetchAllTransactions(opts) {
  const chainId = opts.chainId;
  const appPubkey = opts.appPubkey;
  const queryField = opts.queryField || "recipient";
  const explicitUpstream = opts.upstream || null;
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const maxPages = opts.maxPages || 500;

  if (!chainId || !appPubkey) return { transactions: [], lastHeight: null };

  const allTxs = [];
  let lastHeight = null;
  let cursor = null;

  try {
    for (let page = 0; page < maxPages; page++) {
      const body = { [queryField]: appPubkey, limit: 50 };
      if (cursor) body.cursor = cursor;
      const resp = await httpsJsonExplorer(
        "POST",
        (h) => `${explorerProto(h)}://${h}${upstreamBase}/${chainId}/transactions`,
        body,
        { explicitUpstream },
      );

      const items = Array.isArray(resp) ? resp
        : (resp && Array.isArray(resp.items)) ? resp.items
        : (resp && Array.isArray(resp.transactions)) ? resp.transactions
        : [];

      if (items.length === 0) break;

      for (const tx of items) {
        allTxs.push(tx);
        const bh = tx.block_height;
        if (typeof bh === "number" && (lastHeight == null || bh > lastHeight)) {
          lastHeight = bh;
        }
      }

      if (page % 10 === 0 && page > 0) {
        console.log(`[fetch-txs] page ${page}, ${allTxs.length} txs so far...`);
      }

      const hasMore = resp && resp.has_more;
      const nextCursor = resp && resp.next_cursor;
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
    }
  } catch (e) {
    console.warn(`[fetch-txs] error after ${allTxs.length} txs: ${e.message}`);
  }

  function extractTs(tx) {
    const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
    for (const v of candidates) {
      if (typeof v === "number" && Number.isFinite(v))
        return v < 10_000_000_000 ? v * 1000 : v;
      if (typeof v === "string" && v.trim()) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) return t;
      }
    }
    return 0;
  }

  allTxs.sort((a, b) => extractTs(a) - extractTs(b));
  const txIds = allTxs.map(tx => tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash).filter(Boolean);
  console.log(`[fetch-txs] fetched ${allTxs.length} transaction(s), lastHeight=${lastHeight ?? "none"}`);
  return { transactions: allTxs, lastHeight, txIds };
}

// ── Chain info discovery ─────────────────────────────────────────────────────
//
// Discovers chain_id and estimates genesis timestamp from the block explorer.
// Returns { chainId, genesisTimestampMs } — either field may be null on failure.

async function discoverChainInfo(opts) {
  const explicitUpstream = (opts && opts.upstream) || null;
  const upstreamBase = (opts && opts.upstreamBase) || getExplorerUpstreamBase();

  const result = { chainId: null, genesisTimestampMs: null };

  try {
    const data = await httpsJsonExplorer(
      "GET",
      (h) => `${explorerProto(h)}://${h}${upstreamBase}/active_chain`,
      null,
      { explicitUpstream },
    );
    if (data && data.chain_id) result.chainId = data.chain_id;
  } catch (e) {
    console.warn(`[chain-info] could not discover chain: ${e.message}`);
    return result;
  }

  if (!result.chainId) return result;

  try {
    const data = await httpsJsonExplorer(
      "GET",
      (h) => `${explorerProto(h)}://${h}${upstreamBase}/${result.chainId}/blocks?limit=2`,
      null,
      { explicitUpstream },
    );
    const blocks = (data && data.items) || [];

    if (blocks.length >= 2) {
      const [b1, b2] = blocks;
      const slotDiff = b1.global_slot - b2.global_slot;
      const timeDiff = b1.timestamp_ms - b2.timestamp_ms;
      if (slotDiff > 0 && timeDiff > 0) {
        const slotMs = timeDiff / slotDiff;
        result.genesisTimestampMs = Math.round(b1.timestamp_ms - b1.global_slot * slotMs);
        console.log(`[chain-info] genesis: ${new Date(result.genesisTimestampMs).toISOString()} (slot=${slotMs}ms, chain=${result.chainId.slice(0, 16)}…)`);
      }
    } else if (blocks.length === 1 && blocks[0].global_slot > 0) {
      const b = blocks[0];
      const slotMs = 5000;
      result.genesisTimestampMs = Math.round(b.timestamp_ms - b.global_slot * slotMs);
      console.log(`[chain-info] genesis (estimated, 1 block): ${new Date(result.genesisTimestampMs).toISOString()}`);
    }
  } catch (e) {
    console.warn(`[chain-info] could not fetch blocks for genesis time: ${e.message}`);
  }

  return result;
}

// ── Genesis accounts fetch ───────────────────────────────────────────────
//
// One-shot fetch of genesis-ledger accounts by querying the explorer for
// genesis-type transactions (block height 0). Returns an array of unique
// destination addresses that received genesis distributions.

async function fetchGenesisAccounts(opts) {
  const explicitUpstream = (opts && opts.upstream) || null;
  const upstreamBase = (opts && opts.upstreamBase) || getExplorerUpstreamBase();

  let chainId = opts && opts.chainId;
  if (!chainId) {
    try {
      const data = await httpsJsonExplorer(
        "GET",
        (h) => `${explorerProto(h)}://${h}${upstreamBase}/active_chain`,
        null,
        { explicitUpstream },
      );
      chainId = data && data.chain_id;
    } catch (e) {
      console.warn(`[genesis] could not discover chain: ${e.message}`);
      return [];
    }
  }
  if (!chainId) return [];

  const accounts = new Set();

  try {
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const body = { to_height: 1, limit: 200 };
      if (cursor) body.cursor = cursor;
      const resp = await httpsJsonExplorer(
        "POST",
        (h) => `${explorerProto(h)}://${h}${upstreamBase}/${chainId}/transactions`,
        body,
        { explicitUpstream },
      );

      const items = (resp && Array.isArray(resp.items)) ? resp.items
        : (resp && Array.isArray(resp.transactions)) ? resp.transactions
        : [];

      for (const tx of items) {
        if (tx.tx_type === "genesis" && tx.destination) {
          accounts.add(tx.destination);
        }
      }

      if (!resp || !resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
    }
    console.log(`[genesis] found ${accounts.size} genesis account(s)`);
  } catch (e) {
    console.warn(`[genesis] could not fetch genesis accounts: ${e.message}`);
  }

  return Array.from(accounts);
}

// ── Generic app-state cache ─────────────────────────────────────────────────
//
// One-call wiring of the standard pattern from AGENTS.md Section 7: every dapp
// that maintains shared global state should poll the chain server-side, hold
// the derived state in memory, and serve it from a local HTTP endpoint so
// connected clients hit one small response instead of all paginating the
// explorer independently.
//
// Caller provides:
//   - appPubkey            — the address being polled
//   - queryFields          — ["recipient"], ["sender"], or both. Defaults to ["recipient"].
//   - processTransaction   — pure function: takes a raw explorer tx, mutates internal state.
//   - handleRequest        — pure function: serves the state-as-JSON HTTP endpoint(s).
//   - onChainReset         — called when the chain id changes (clear caller state).
//   - localDev             — gate chain polling off and drain mockTransactions instead.
//   - mockTransactions     — array from createMockApi; drained on a 1s timer in localDev.
//   - intervalMs           — live-poll interval (default 3000).
//   - backfill             — run fetchAllTransactions once at start (default true).
//   - initialRawTxs        — optional array of raw explorer txs to pre-seed
//     the visible /status history without running them through
//     processTransaction. Use when the dapp ran its own backfill outside
//     this helper (engine constructor, custom replay logic) and the
//     caller-managed processing has already consumed those txs — but
//     they still need to be visible to operators checking /status.
//   - initialLastHeight    — seed the live poller from this block height
//     (used together with initialSeenIds when backfill is disabled).
//   - initialSeenIds       — tx ids the live poller should treat as
//     already-processed (dedup safety net for overlapping fetches).
//   - name                 — short label for log lines.
//   - nodeRpcUrl           — optional. URL of a usernode RPC server.
//     When set, the `recipient` queryField switches to the node's SSE
//     fast path automatically (see `useNodeStream`).
//   - useNodeStream        — defaults to true whenever `nodeRpcUrl` is
//     set. The `recipient` queryField is then served by a direct-to-node
//     SSE stream + catch-up poll (see createNodeRecentTxStream) instead
//     of paginating the explorer, dropping live-tail latency from 5–60s
//     (explorer indexing) to sub-second. Requires the node to expose
//     `/transactions/by_recipient` and `/transactions/stream` (i.e.
//     started with `--enable-recent-tx-stream`). Pass `false` to opt
//     out — useful when targeting an older node that lacks those
//     endpoints. Other queryFields keep the explorer path; backfill is
//     always explorer-driven.
//
// Helper handles:
//   - Discover chain id, backfill history (oldest→newest, interleaved across
//     multiple queryFields) before any live polling. Avoids out-of-order
//     processing when both incoming and outgoing txs matter to the app.
//   - Live polling via createChainPoller per queryField with `from_height`
//     incremental fetches.
//   - Mock-mode drain of mockTransactions (no chain polling).
//   - Forwarding handleRequest so the caller's HTTP routes are served from
//     the cache wiring.

function _appStateExtractTs(tx) {
  const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v))
      return v < 10_000_000_000 ? v * 1000 : v;
    if (typeof v === "string" && v.trim()) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

function _appStateExtractId(tx) {
  return tx.tx_id || tx.id || tx.txid || tx.hash || tx.tx_hash || null;
}

function createAppStateCache(opts) {
  opts = opts || {};
  const appPubkey = opts.appPubkey;
  if (!appPubkey) throw new Error("createAppStateCache: appPubkey is required");
  const userProcessTransaction = opts.processTransaction;
  if (typeof userProcessTransaction !== "function") {
    throw new Error("createAppStateCache: processTransaction(tx) is required");
  }
  // No-op default so callers can unconditionally do `cache.handleRequest(req, res, pathname)`
  // without nil-checks even when the dapp routes its own HTTP separately.
  const userHandleRequest = typeof opts.handleRequest === "function"
    ? opts.handleRequest
    : function () { return false; };
  const queryFields = Array.isArray(opts.queryFields) && opts.queryFields.length
    ? opts.queryFields
    : ["recipient"];
  const onChainReset = opts.onChainReset || null;
  const localDev = !!opts.localDev;
  const mockTransactions = opts.mockTransactions || null;
  const intervalMs = opts.intervalMs || 3000;
  // Only freeze a host when the caller explicitly pinned one (tests,
  // single-host overrides). Otherwise forward `null` to the inner
  // helpers so each request goes through httpsJsonExplorer and resolves
  // the active host fresh against the probe's health table — caches
  // booted before the probe has data no longer freeze onto a dead host.
  const explicitUpstream = opts.upstream || null;
  const upstreamBase = opts.upstreamBase || getExplorerUpstreamBase();
  const wantBackfill = opts.backfill !== false;
  // Optional caller-supplied seed for the live poller. Useful when the dapp
  // ran its own backfill before creating the cache (e.g. falling-sands feeds
  // historical txs into its engine constructor for windowed replay) and just
  // needs the poller to start from where that left off.
  const initialLastHeight = opts.initialLastHeight != null ? opts.initialLastHeight : null;
  const initialSeenIds = Array.isArray(opts.initialSeenIds) ? opts.initialSeenIds : null;
  // Pre-seed the visible raw-tx store without replaying through
  // processTransaction. Falling-sands needs this: its engine already
  // consumed historical txs in its constructor, so re-routing them
  // through processTransaction would double-apply. Without seeding, the
  // /status "Recent Transactions" panel for sands sits empty until new
  // live txs arrive, which on a low-traffic dapp can be hours.
  const initialRawTxs = Array.isArray(opts.initialRawTxs) ? opts.initialRawTxs : null;
  const name = opts.name || appPubkey.slice(0, 12) + "…";
  // Direct-to-node fast path. Defaults ON whenever `nodeRpcUrl` is set so
  // dapps don't need to plumb a feature flag — sub-second live-tail is
  // simply what you get when a node is reachable. Requires the node to
  // expose `/transactions/by_recipient` + `/transactions/stream` (i.e.
  // started with `--enable-recent-tx-stream`; see
  // `usernode/docs/reference/rpc.md`). When the cache includes the
  // `recipient` queryField, live updates for that field come from SSE +
  // catch-up poll instead of paginating the explorer. Other queryFields
  // (sender, account) keep the explorer poller — the node endpoints only
  // cover incoming traffic. Backfill is always explorer-driven.
  //
  // Pass `useNodeStream: false` to opt out (e.g. when targeting an older
  // node that lacks the SSE endpoints).
  const nodeRpcUrl = opts.nodeRpcUrl || null;
  const useNodeStream = (opts.useNodeStream !== false) && !!nodeRpcUrl;

  // ── Raw-tx store + bridge-facing HTTP endpoint ──────────────────────────
  //
  // Every tx that flows through processTransaction is also retained here so
  // the bridge's waitForTransactionVisible can poll the local cache instead
  // of redundantly polling the explorer. One server poll → many client reads.
  //
  // Stored unbounded by design: the cache is rebuilt from chain history on
  // every restart, so it never grows past one server's lifetime, and a few
  // hundred bytes per tx puts the practical ceiling far above what these
  // dapps generate. Add a `maxRetained` opt later if a dapp ever approaches
  // it.
  const rawTxs = []; // chronological insertion order
  const rawTxIds = new Set();
  if (initialRawTxs && initialRawTxs.length) {
    for (const tx of initialRawTxs) {
      if (!tx || typeof tx !== "object") continue;
      const id = _appStateExtractId(tx);
      if (id && rawTxIds.has(id)) continue;
      if (id) rawTxIds.add(id);
      rawTxs.push(tx);
    }
  }
  const cacheRoutePrefix = `/__usernode/cache/${appPubkey}`;

  // Listeners notified after every processTransaction. Used by
  // createDappServerStatus to debounce SSE pushes — `cb(rawTx)` is called
  // post-user-processor so listeners observe state in its final form.
  // Errors in listeners are swallowed; status notifications must never
  // poison the chain pipeline.
  const txProcessedListeners = new Set();
  function onTxProcessed(cb) {
    if (typeof cb !== "function") return () => {};
    txProcessedListeners.add(cb);
    return () => { txProcessedListeners.delete(cb); };
  }

  // Listeners notified when a waiter is added or removed (open / match /
  // timeout / disconnect). Lets createDappServerStatus push a fresh
  // snapshot to /status viewers immediately so the operator sees a new
  // user click "send" without waiting for the 5s safety tick.
  const waiterChangeListeners = new Set();
  function onWaiterChange(cb) {
    if (typeof cb !== "function") return () => {};
    waiterChangeListeners.add(cb);
    return () => { waiterChangeListeners.delete(cb); };
  }
  function _fireWaiterChange() {
    for (const cb of waiterChangeListeners) {
      try { cb(); } catch (_) {}
    }
  }

  // ── Inclusion-wait waiters (SSE) ───────────────────────────────────────
  //
  // Each entry represents a connected client (typically the bridge inside a
  // dapp page) that is waiting for a specific transaction to land in this
  // cache. Replaces the bridge's polling loop on /getTransactions when the
  // bridge has `serverCacheUrl` configured: instead of N polls per send,
  // one persistent SSE connection per send.
  //
  // The Map is also the source of truth for "client pending sends" on the
  // /status page — every open SSE here = one user actively waiting.
  //
  // Cleanup is symmetric: req.on('close') fires on tab close / network
  // drop, and the timeout timer runs as a backstop. Sending `event: matched`
  // followed by res.end() triggers the bridge's EventSource.close() which
  // in turn fires req.on('close'), so we never have to manually delete
  // post-match.
  const waiters = new Map();

  // Bounded ring of completed SSE waiters, newest-first. Powers the
  // "Recent client sends" section on /status — useful for diagnosing
  // timeouts (chain didn't include in time? bridge predicate wrong?
  // sidecar stalled?) without having to be staring at the page when it
  // happens. Capped at RECENT_WAITERS_LIMIT to keep snapshots small.
  const RECENT_WAITERS_LIMIT = 50;
  const recentWaiters = [];

  function _recordWaiterEnd(meta, finalStatus) {
    const endedAt = Date.now();
    const startedAt = meta.startedAt || endedAt;
    const expected = meta.expected || {};
    const memoStr = expected.memo != null ? String(expected.memo) : null;
    recentWaiters.unshift({
      finalStatus,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      timeoutMs: meta.expiresAt != null ? meta.expiresAt - startedAt : null,
      sender: expected.from_pubkey || null,
      recipient: expected.destination_pubkey || null,
      memoPreview: memoStr != null ? memoStr.slice(0, 120) : null,
      txId: expected.txId ? String(expected.txId) : null,
      clientId: meta.clientId || null,
    });
    if (recentWaiters.length > RECENT_WAITERS_LIMIT) {
      recentWaiters.length = RECENT_WAITERS_LIMIT;
    }
  }

  function _matchAgainstWaiters(rawTx) {
    if (!rawTx || waiters.size === 0) return;
    let removed = false;
    for (const [id, w] of waiters) {
      let hit;
      try { hit = txMatches(rawTx, w.expected); }
      catch (_) { hit = false; }
      if (!hit) continue;
      try {
        w.res.write("event: matched\n");
        w.res.write(`data: ${JSON.stringify(rawTx)}\n\n`);
      } catch (_) {}
      try { w.res.end(); } catch (_) {}
      // The req.on('close') cleanup will fire and remove the entry, but
      // delete here too so any synchronous follow-up (status snapshot,
      // getStats) sees the post-match state. Record before delete so the
      // history captures the match before cleanup runs (which would
      // otherwise see had=false and skip).
      _recordWaiterEnd(w, "matched");
      waiters.delete(id);
      removed = true;
    }
    if (removed) _fireWaiterChange();
  }

  function processTransaction(rawTx) {
    if (rawTx && typeof rawTx === "object") {
      const id = _appStateExtractId(rawTx);
      if (!id || !rawTxIds.has(id)) {
        if (id) rawTxIds.add(id);
        rawTxs.push(rawTx);
      }
      _maybeWarnNullSource(rawTx);
    }
    const result = userProcessTransaction(rawTx);
    // Wake bridge waiters before notifying status listeners — the latency
    // path matters here; the status SSE just rerenders.
    _matchAgainstWaiters(rawTx);
    for (const cb of txProcessedListeners) {
      try { cb(rawTx); } catch (_) {}
    }
    return result;
  }

  // ── PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG detector ─────────────────────────
  //
  // Counts transfers that arrive missing `source`/`from_pubkey`/`from`. On a
  // healthy full-ledger sidecar this is always zero. On a partial-ledger
  // sidecar (Replace fired, OR boot without an archive snapshot), the SSE
  // stream delivers RecentTxEntry rows with `source: null` and the dapp
  // cache silently drops them — exactly the "tx never appears in the dapp
  // UI" failure mode in PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG.md.
  //
  // We log loud on the FIRST occurrence so it can't slip past a passive
  // logs reader, then throttle subsequent warnings to once every 5 minutes
  // with the running rate. Counters are exposed via `getStats()` so a
  // health endpoint can scrape and alert.
  let _nullSourceCount = 0;
  let _transferTotalCount = 0;
  let _firstNullSourceLogged = false;
  let _lastNullSourceWarnAt = 0;
  const _NULL_SOURCE_WARN_INTERVAL_MS = 5 * 60 * 1000;

  function _maybeWarnNullSource(rawTx) {
    const txType = rawTx.tx_type || rawTx.type;
    // Rewards / genesis legitimately have no source. Only `transfer`s carry
    // a sender — that's where missing source means the bug.
    if (txType && txType !== "transfer") return;
    const source = rawTx.source != null
      ? rawTx.source
      : (rawTx.from_pubkey != null ? rawTx.from_pubkey : rawTx.from);
    _transferTotalCount++;
    if (source != null) return;
    _nullSourceCount++;
    const now = Date.now();
    if (!_firstNullSourceLogged) {
      _firstNullSourceLogged = true;
      const id = _appStateExtractId(rawTx);
      console.warn(
        `[${name}] PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG: first incoming transfer with source=null (tx_id=${id || "<unknown>"}). ` +
        `Sidecar is in partial-ledger mode — dapp UI will silently drop incoming txs from non-tracked senders. ` +
        `Restart the sidecar with a fresh archive snapshot. Subsequent occurrences throttled to one warning every 5 min.`
      );
      _lastNullSourceWarnAt = now;
      return;
    }
    if (now - _lastNullSourceWarnAt < _NULL_SOURCE_WARN_INTERVAL_MS) return;
    _lastNullSourceWarnAt = now;
    const pct = _transferTotalCount > 0
      ? ((_nullSourceCount / _transferTotalCount) * 100).toFixed(1)
      : "?";
    console.warn(
      `[${name}] PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG ongoing: ${_nullSourceCount}/${_transferTotalCount} transfers missing source (${pct}%) since boot.`
    );
  }

  function getNullSourceStats() {
    return {
      nullSourceCount: _nullSourceCount,
      transferTotalCount: _transferTotalCount,
      firstSeen: _firstNullSourceLogged,
    };
  }

  // Read-only access to the cache's raw-tx list, in chronological (insertion)
  // order. Useful for in-process consumers (e.g. a dapp HTTP route) that want
  // the same data the bridge sees but without going through HTTP. Caller
  // must not mutate the returned array.
  function getRawTransactions() {
    return rawTxs;
  }

  function _onChainResetWrapped(newId, oldId) {
    rawTxs.length = 0;
    rawTxIds.clear();
    if (typeof onChainReset === "function") onChainReset(newId, oldId);
  }

  function _txField(tx, ...keys) {
    for (const k of keys) {
      const v = tx && tx[k];
      if (v != null) return v;
    }
    return null;
  }

  function _filterCachedTxs(filter) {
    const limit = typeof filter.limit === "number" && filter.limit > 0 ? filter.limit : 50;
    const sender = filter.sender || null;
    const recipient = filter.recipient || null;
    const account = filter.account || null;
    const out = [];
    // Newest-first (matches explorer API ordering).
    for (let i = rawTxs.length - 1; i >= 0 && out.length < limit; i--) {
      const tx = rawTxs[i];
      const from = _txField(tx, "source", "from_pubkey", "from");
      const to = _txField(tx, "destination", "destination_pubkey", "to");
      if (sender && from !== sender) continue;
      if (recipient && to !== recipient) continue;
      if (account && from !== account && to !== account) continue;
      out.push(tx);
    }
    return out;
  }

  function handleCacheRequest(req, res, pathname) {
    if (!pathname || !pathname.startsWith(cacheRoutePrefix)) return false;
    const sub = pathname.slice(cacheRoutePrefix.length);

    if ((sub === "/info" || sub === "") &&
        (req.method === "GET" || req.method === "HEAD")) {
      const body = JSON.stringify({
        enabled: true,
        app_pubkey: appPubkey,
        count: rawTxs.length,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(req.method === "HEAD" ? "" : body);
      return true;
    }

    if (sub === "/getTransactions" && req.method === "POST") {
      readJson(req).then(
        (filter) => {
          const items = _filterCachedTxs(filter || {});
          const body = JSON.stringify({
            items,
            count: items.length,
            total_in_cache: rawTxs.length,
          });
          res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          });
          res.end(body);
        },
        (err) => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json: " + err.message }));
        }
      );
      return true;
    }

    // SSE inclusion wait — replaces the bridge's polling loop on
    // /getTransactions when window.usernode.serverCacheUrl is set. The
    // bridge opens an EventSource here at the start of each
    // sendTransaction; we hold the connection open and write
    // `event: matched` the instant a tx landing in our cache satisfies
    // the predicate.
    //
    // Query string carries the predicate fields (all optional, conjunctive
    // in txMatches): sender, recipient/dest, memo, txId, minCreatedAtMs.
    // Plus operational fields: timeoutMs (server-side hard cap),
    // clientId (opaque, surfaced on /status).
    if (sub === "/waitForTx" && (req.method === "GET" || req.method === "HEAD")) {
      _handleWaitForTxSse(req, res);
      return true;
    }

    return false;
  }

  function _handleWaitForTxSse(req, res) {
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch (_) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("invalid url");
      return;
    }
    const q = parsedUrl.searchParams;

    const expected = {};
    if (q.has("sender")) expected.from_pubkey = q.get("sender");
    const recipient = q.get("recipient") || q.get("dest") || q.get("destination");
    if (recipient) expected.destination_pubkey = recipient;
    if (q.has("memo")) expected.memo = q.get("memo");
    if (q.has("txId")) expected.txId = q.get("txId");
    if (q.has("minCreatedAtMs")) {
      const n = Number(q.get("minCreatedAtMs"));
      if (Number.isFinite(n)) expected.minCreatedAtMs = n;
    }

    // Reject empty predicates — without at least one narrowing field the
    // first incoming tx would wake the waiter and the bridge would think
    // *some other* tx was its confirmation. Bridges always pass at least
    // sender or txId; this guards against misconfiguration.
    const hasNarrowing = expected.txId || expected.from_pubkey
      || expected.destination_pubkey || expected.memo;
    if (!hasNarrowing) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("waitForTx requires at least one predicate field (sender, recipient, memo, or txId)");
      return;
    }

    // 180s hard cap matches the bridge's default timeoutMs. Bridge can
    // pass a smaller value to tighten its own ceiling; passing larger is
    // ignored — we never hold a connection longer than 5 minutes.
    const SERVER_HARD_CAP_MS = 5 * 60 * 1000;
    const requestedTimeout = Number(q.get("timeoutMs"));
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, SERVER_HARD_CAP_MS)
      : 180000;

    const clientId = q.get("clientId") || null;
    const startedAt = Date.now();
    const id = crypto.randomUUID();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    // Race coverage: the tx may already be in the cache by the time the
    // bridge subscribes (server-side processing is faster than the round
    // trip to wallet → confirmation → bridge → SSE). Scan first, only
    // register if no hit. Newest-first is fine — first match wins.
    for (let i = rawTxs.length - 1; i >= 0; i--) {
      let hit;
      try { hit = txMatches(rawTxs[i], expected); }
      catch (_) { hit = false; }
      if (hit) {
        try {
          res.write("event: matched\n");
          res.write(`data: ${JSON.stringify(rawTxs[i])}\n\n`);
        } catch (_) {}
        try { res.end(); } catch (_) {}
        // Synthesize a meta record so the operator sees this on /status
        // alongside normal matches — distinguishing the race-coverage
        // path is useful when debugging "why was it instant?" questions.
        _recordWaiterEnd(
          { expected, clientId, startedAt, expiresAt: startedAt + timeoutMs },
          "matched-immediate"
        );
        _fireWaiterChange();
        return;
      }
    }

    // No existing match — register and hold the connection.
    const keepAlive = setInterval(() => {
      try { res.write(":keep-alive\n\n"); } catch (_) {}
    }, 15000);
    if (keepAlive.unref) keepAlive.unref();

    const timeoutHandle = setTimeout(() => {
      const w = waiters.get(id);
      if (!w) return;
      try {
        res.write("event: timeout\n");
        res.write(`data: {"timeoutMs":${timeoutMs}}\n\n`);
      } catch (_) {}
      try { res.end(); } catch (_) {}
      _recordWaiterEnd(w, "timeout");
      waiters.delete(id);
      _fireWaiterChange();
    }, timeoutMs);
    if (timeoutHandle.unref) timeoutHandle.unref();

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(keepAlive);
      clearTimeout(timeoutHandle);
      const w = waiters.get(id);
      const had = waiters.delete(id);
      // had=true only when neither match nor timeout already removed
      // this entry, so this is genuinely a tab-close / network-drop
      // event. Match and timeout paths record before they delete, so
      // they short-circuit here cleanly.
      if (had) {
        if (w) _recordWaiterEnd(w, "disconnected");
        _fireWaiterChange();
      }
    }
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);

    waiters.set(id, {
      expected,
      res,
      clientId,
      startedAt,
      expiresAt: startedAt + timeoutMs,
    });
    _fireWaiterChange();
  }

  function handleRequest(req, res, pathname) {
    if (handleCacheRequest(req, res, pathname)) return true;
    return userHandleRequest(req, res, pathname);
  }

  let started = false;

  // Tracks whether the cache has finished its initial historical fill.
  // Surfaced via `isStreamReady()` so the dapp-loading overlay can keep
  // the UI gated until the cache has both (a) caught up on history and
  // (b) wired its live feeder. Without (a) the user could click "send"
  // against a partially-hydrated state and see broken-looking results;
  // without (b) sends would land on chain without ever appearing in the
  // dapp UI.
  //   - localDev: ready as soon as start() finishes (no real chain).
  //   - backfill:false: caller is doing its own backfill (e.g. sands
  //     replay) — defer the flag to the caller (set true on start()).
  //   - default: flips true at the end of the explorer-driven backfill.
  let backfillDone = false;
  let nodeStream = null;

  function isStreamReady() {
    if (!started) return false;
    if (!backfillDone) return false;
    if (nodeStream) return nodeStream.isReady();
    return true;
  }

  // Compact snapshot for /__usernode/status. Keep `recent` and `waiters`
  // bounded so the SSE payload stays small (5 caches × 20 txs + 20 waiters
  // is still single-digit KB).
  function getStats() {
    const recentLimit = 20;
    const recent = [];
    for (let i = rawTxs.length - 1; i >= 0 && recent.length < recentLimit; i--) {
      const tx = rawTxs[i];
      const memoStr = tx.memo != null ? String(tx.memo) : null;
      recent.push({
        id: _appStateExtractId(tx),
        from: _txField(tx, "source", "from_pubkey", "from"),
        to: _txField(tx, "destination", "destination_pubkey", "to"),
        amount: tx.amount != null ? tx.amount : null,
        memo: memoStr != null ? memoStr.slice(0, 240) : null,
        ts: _appStateExtractTs(tx),
        blockHeight: typeof tx.block_height === "number" ? tx.block_height : null,
        txType: tx.tx_type || tx.type || null,
      });
    }
    // Project waiters in reverse-chronological (newest first) so the most
    // recently-opened wait is at the top — matches how an operator scans
    // an incident.
    const now = Date.now();
    const waitersList = [];
    const waitersAll = Array.from(waiters.values()).sort((a, b) => b.startedAt - a.startedAt);
    for (let i = 0; i < Math.min(20, waitersAll.length); i++) {
      const w = waitersAll[i];
      const memoStr = w.expected.memo != null ? String(w.expected.memo) : null;
      waitersList.push({
        ageMs: now - w.startedAt,
        timeoutMs: w.expiresAt - w.startedAt,
        sender: w.expected.from_pubkey || null,
        recipient: w.expected.destination_pubkey || null,
        memoPreview: memoStr != null ? memoStr.slice(0, 120) : null,
        txId: w.expected.txId ? String(w.expected.txId) : null,
        clientId: w.clientId,
      });
    }
    return {
      name,
      appPubkey,
      queryFields: queryFields.slice(),
      mode: localDev ? "local-dev" : "production",
      count: rawTxs.length,
      backfillDone,
      streamReady: isStreamReady(),
      nullSource: getNullSourceStats(),
      nodeStream: nodeStream && typeof nodeStream.getStats === "function"
        ? nodeStream.getStats()
        : null,
      recent,
      waitersCount: waiters.size,
      waiters: waitersList,
      recentWaitersCount: recentWaiters.length,
      recentWaiters: recentWaiters.slice(0, 20),
    };
  }

  async function start() {
    if (started) return;
    started = true;

    if (localDev) {
      backfillDone = true;
      if (mockTransactions) {
        let idx = 0;
        setInterval(() => {
          while (idx < mockTransactions.length) {
            processTransaction(mockTransactions[idx]);
            idx++;
          }
        }, 1000);
        console.log(`[${name}] mock drain started (queryFields=[${queryFields.join(",")}])`);
      }
      return;
    }

    // Production: backfill history (interleaved across queryFields, sorted
    // chronologically), then start live pollers.
    let chainId = null;
    try {
      const info = await discoverChainInfo({ upstream: explicitUpstream, upstreamBase });
      chainId = info.chainId;
    } catch (_) {}

    let lastHeight = initialLastHeight;
    const backfillIds = initialSeenIds ? initialSeenIds.slice() : [];
    if (wantBackfill && chainId) {
      const allTxs = [];
      for (const queryField of queryFields) {
        try {
          const fetched = await fetchAllTransactions({
            chainId,
            appPubkey,
            queryField,
            upstream: explicitUpstream,
            upstreamBase,
          });
          allTxs.push(...fetched.transactions);
          if (fetched.lastHeight != null && (lastHeight == null || fetched.lastHeight > lastHeight)) {
            lastHeight = fetched.lastHeight;
          }
          for (const id of fetched.txIds || []) backfillIds.push(id);
        } catch (e) {
          console.warn(`[${name}] backfill (${queryField}) failed: ${e.message}`);
        }
      }
      // Re-sort across queryFields and dedup so pathological self-sends
      // (sender == recipient) aren't double-counted.
      allTxs.sort((a, b) => _appStateExtractTs(a) - _appStateExtractTs(b));
      const seen = new Set();
      let processed = 0;
      for (const tx of allTxs) {
        const id = _appStateExtractId(tx);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        processTransaction(tx);
        processed++;
      }
      console.log(`[${name}] backfill complete: ${processed} tx(s) processed (lastHeight=${lastHeight ?? "none"})`);
    }
    // Caller-managed backfill (backfill:false) is treated as "done" as
    // soon as start() reaches this point — the caller's own pipeline has
    // already finished by definition (the cache constructor returned).
    backfillDone = true;

    for (const queryField of queryFields) {
      // Direct-to-node SSE + catch-up replaces the explorer poller for the
      // `recipient` queryField when `useNodeStream` is opted in and the
      // node URL is set. Drops live-tail latency from explorer-indexing
      // time (5–60s observed) to sub-second push.
      if (useNodeStream && queryField === "recipient") {
        const stream = createNodeRecentTxStream({
          nodeRpcUrl,
          recipient: appPubkey,
          onTransaction: processTransaction,
          name: `${name}:node-stream`,
          initialLastHeight: lastHeight,
        });
        nodeStream = stream;
        if (backfillIds.length) stream.addSeenIds(backfillIds);
        stream.start();
        continue;
      }
      const poller = createChainPoller({
        appPubkey,
        queryField,
        onTransaction: processTransaction,
        onChainReset: _onChainResetWrapped,
        intervalMs,
        upstream: explicitUpstream,
        upstreamBase,
      });
      if (lastHeight != null) poller.setInitialLastHeight(lastHeight);
      if (backfillIds.length) poller.addSeenIds(backfillIds);
      poller.start();
    }
  }

  return {
    start,
    handleRequest,
    processTransaction,
    getRawTransactions,
    isStreamReady,
    getNullSourceStats,
    getStats,
    onTxProcessed,
    onWaiterChange,
    appPubkey,
    name,
  };
}

// ── Global usernames cache ──────────────────────────────────────────────────
//
// Thin wrapper around createAppStateCache for the global usernames address.
// Owns the in-memory username map + the GET /__usernames/state HTTP endpoint;
// delegates chain plumbing (backfill + poll + mock drain) to the generic
// helper. Caller wiring is identical to any other createAppStateCache use.

// The well-known global usernames address. Hardcoded fallback so the lib still
// works when callers don't pass `usernamesPubkey`. Override via env (used by
// every server.js in this repo) so `make node` / docker-compose can track the
// same address as a wallet owner — required for the new SSE recent_tx_stream
// to deliver live username updates.
const DEFAULT_USERNAMES_PUBKEY =
  process.env.USERNAMES_PUBKEY ||
  "ut1p0p7y8ujacndc60r4a7pzk45dufdtarp6satvc0md7866633u8sqagm3az";

function _usernamesParseMemo(m) {
  if (m == null) return null;
  try { return JSON.parse(String(m)); } catch (_) { return null; }
}

function _usernamesNormalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  return {
    id: _appStateExtractId(tx),
    from: tx.from_pubkey || tx.from || tx.source || null,
    to: tx.destination_pubkey || tx.to || tx.destination || null,
    memo: tx.memo != null ? String(tx.memo) : null,
    ts: _appStateExtractTs(tx) || Date.now(),
  };
}

function createUsernamesCache(opts) {
  opts = opts || {};
  const usernamesPubkey = opts.usernamesPubkey || DEFAULT_USERNAMES_PUBKEY;

  // pubkey → { name, ts } — latest-ts-wins per sender.
  const usernames = new Map();
  let lastSeenTs = 0;

  function processTransaction(rawTx) {
    const tx = _usernamesNormalizeTx(rawTx);
    if (!tx || !tx.from || tx.to !== usernamesPubkey) return;
    const memo = _usernamesParseMemo(tx.memo);
    if (!memo || memo.app !== "usernames" || memo.type !== "set_username") return;
    const raw = String(memo.username || "").trim();
    if (!raw) return;
    const prev = usernames.get(tx.from);
    if (!prev || tx.ts >= prev.ts) {
      usernames.set(tx.from, { name: raw, ts: tx.ts });
    }
    if (tx.ts > lastSeenTs) lastSeenTs = tx.ts;
  }

  function getStateResponse() {
    const map = {};
    for (const [k, v] of usernames) map[k] = v.name;
    return {
      usernames: map,
      lastSeenTs,
      usernamesPubkey,
      count: usernames.size,
    };
  }

  function handleStateRequest(req, res, pathname) {
    if (pathname !== "/__usernames/state") return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const body = JSON.stringify(getStateResponse());
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  function reset() {
    usernames.clear();
    lastSeenTs = 0;
    console.log("[usernames] cache reset (chain restart detected)");
  }

  const cache = createAppStateCache({
    name: "usernames",
    appPubkey: usernamesPubkey,
    queryFields: ["recipient"],
    processTransaction,
    handleRequest: handleStateRequest,
    onChainReset: reset,
    localDev: opts.localDev,
    mockTransactions: opts.mockTransactions || null,
    intervalMs: opts.intervalMs,
    upstream: opts.upstream,
    upstreamBase: opts.upstreamBase,
    nodeRpcUrl: opts.nodeRpcUrl || null,
    // Pass through unmodified so createAppStateCache's default (on whenever
    // nodeRpcUrl is set) applies. Coercing undefined→false here would shadow
    // the default and force every caller to plumb the flag explicitly.
    useNodeStream: opts.useNodeStream,
  });

  // Expose `cache.handleRequest` (not the inner `handleStateRequest`) so the
  // auto-mounted /__usernode/cache/<usernamesPubkey>/* routes are reachable
  // — that's what the bridge's serverCacheUrl-based inclusion polling hits.
  // `cache.handleRequest` already chains its own cache-route check in front
  // of `handleStateRequest`, so callers get both endpoints from one entry.
  //
  // Also pass through `getStats` / `onTxProcessed` so `createDappServerStatus`
  // can register the usernames cache uniformly with any other cache.
  return {
    start: cache.start,
    handleRequest: cache.handleRequest,
    processTransaction,
    getStateResponse,
    reset,
    usernamesPubkey,
    appPubkey: cache.appPubkey,
    isStreamReady: cache.isStreamReady,
    getStats: cache.getStats,
    onTxProcessed: cache.onTxProcessed,
    onWaiterChange: cache.onWaiterChange,
    name: cache.name,
  };
}

// ── Sidecar /status probe ───────────────────────────────────────────────────
//
// One server-side probe per dapp server polls the sidecar's `GET /status`
// (RpcStatusResp from `crates/node/src/rpc/rpcs/status.rs`) on a fixed
// interval and serves the cached snapshot at `GET /__usernode/node_status`.
// Connected clients then poll the local endpoint instead of hitting the
// sidecar directly — N tabs ≠ N sidecar requests.
//
// Snapshot shape (returned by `get()` and the HTTP endpoint):
//   {
//     status:            "unknown" | "unreachable" | "Connecting" |
//                        "Connected" | "Syncing" | "Synced" | "mock",
//     peers:             number,        // connected peer count
//     bestTipHeight:     number | null, // our node's best tip
//     peerBestTipHeight: number | null, // max best_tip_height across
//                                       // connected peers — for sync %
//     error:             string | null, // populated when last cycle failed
//     streams:           { [name]: bool }, // per-dapp stream readiness;
//                                       // see registerStream() below
//     at:                number,        // ms since epoch when refreshed
//   }
//
// Modes:
//   - localDev:true                    → status="mock", no timer
//   - nodeRpcUrl unset                 → status="unknown", no timer
//   - normal                           → poll /status every intervalMs
//
// HTTP route mounted at exactly `/__usernode/node_status` (CORS *,
// no-store) — matches the existing `/__usernames/state` policy.

function createNodeStatusProbe(opts) {
  opts = opts || {};
  const nodeRpcUrl = opts.nodeRpcUrl || null;
  // Steady-state interval used once the node is `Synced`. During boot we
  // poll faster (`bootIntervalMs`) so the loader can actually see the
  // intermediate `Connecting`/`Connected`/`Syncing` transitions — they
  // can fly by in well under 2s on a warm sidecar.
  const intervalMs = opts.intervalMs || 2000;
  const bootIntervalMs = opts.bootIntervalMs || 500;
  const localDev = !!opts.localDev;
  const ROUTE = "/__usernode/node_status";

  // Latches once we've ever observed `Synced`. Persists for the probe's
  // lifetime (resets on server restart, which is fine — a restart implies
  // we genuinely don't know if the node is caught up).
  //
  // Surfaced in every snapshot so the client loader can use it to decide
  // whether `Syncing` / `Connected` is "we already trust this node, it's
  // just applying new blocks" vs "fresh boot, please wait".
  let hasBeenSynced = false;

  // Same trust-after-first-ok latch for the block-explorer probe. The
  // explorer is an independent service (separate host, separate failure
  // mode from the sidecar) so it gets its own latch. Loaders use this
  // to decide "explorer-down means cache backfill is broken" (fresh
  // boot) vs "explorer-down is tolerable, we already backfilled" (warm).
  let explorerHasBeenOk = false;

  // Per-dapp stream readiness sources. Each registered stream contributes
  // a boolean to `snapshot.streams[name]`. Callers (the dapp-loading
  // overlay) opt into gating their dismiss on a specific stream via
  // `UsernodeLoading.init({ streamKey: "<name>" })`. Computed fresh on
  // every read so the loader doesn't have to wait one tick interval to
  // observe an SSE that just came up.
  const streamSources = new Map();
  function registerStream(streamName, isReadyFn) {
    if (typeof streamName !== "string" || !streamName) {
      throw new Error("registerStream: streamName required");
    }
    if (typeof isReadyFn !== "function") {
      throw new Error("registerStream: isReadyFn required");
    }
    streamSources.set(streamName, isReadyFn);
  }
  function readStreams() {
    const out = {};
    for (const [streamName, fn] of streamSources) {
      try { out[streamName] = !!fn(); } catch (_) { out[streamName] = false; }
    }
    return out;
  }

  let snapshot = {
    status: "unknown",
    peers: 0,
    bestTipHeight: null,
    peerBestTipHeight: null,
    error: null,
    hasBeenSynced: false,
    hasFullUtxoDb: null,
    at: Date.now(),
  };
  // Aggregated explorer snapshot. `hosts[]` carries the per-host detail
  // for the dashboard; `status` is the rolled-up signal that loaders gate
  // on (`ok` if every host is healthy, `degraded` if at least one is, and
  // `unreachable`/`bad_response` only if every host fails). `host` and
  // `activeHost` point to whichever host the proxy/pollers should use
  // right now (first ok host, or first configured host as a last resort).
  let explorerSnapshot = {
    status: "unknown",
    host: getExplorerUpstreams()[0] || null,
    activeHost: null,
    hosts: getExplorerUpstreams().map((host) => ({
      host,
      status: "unknown",
      chainId: null,
      latencyMs: null,
      error: null,
      at: Date.now(),
    })),
    chainId: null,
    latencyMs: null,
    error: null,
    at: Date.now(),
  };
  let lastStatus = "unknown";
  let lastExplorerStatus = "unknown";

  // Listeners called after every probe tick. Used by createDappServerStatus
  // to push fresh status snapshots to SSE clients without polling.
  // Errors in listeners are swallowed; status updates must never poison
  // the probe loop.
  const updateListeners = new Set();
  function onUpdate(cb) {
    if (typeof cb !== "function") return () => {};
    updateListeners.add(cb);
    return () => { updateListeners.delete(cb); };
  }
  function fireUpdateListeners() {
    if (updateListeners.size === 0) return;
    const merged = buildSnapshot();
    for (const cb of updateListeners) {
      try { cb(merged); } catch (_) {}
    }
  }
  // Tri-state so we only log when the flag actually changes value, not the
  // first time we observe it. `null` = never observed yet (probe just
  // started or sidecar unreachable).
  let lastHasFullUtxoDb = null;
  let timer = null;
  let started = false;

  function logStatusChange(newStatus, errMsg) {
    if (newStatus === lastStatus) return;
    lastStatus = newStatus;
    if (errMsg) {
      console.log(`[node-status] -> ${newStatus} (${errMsg})`);
    } else {
      console.log(`[node-status] -> ${newStatus}`);
    }
  }

  function logExplorerStatusChange(newStatus, errMsg) {
    if (newStatus === lastExplorerStatus) return;
    lastExplorerStatus = newStatus;
    if (errMsg) {
      console.log(`[explorer-status] -> ${newStatus} (${errMsg})`);
    } else {
      console.log(`[explorer-status] -> ${newStatus}`);
    }
  }

  function logFullUtxoDbChange(newVal) {
    if (newVal === lastHasFullUtxoDb) return;
    const prev = lastHasFullUtxoDb;
    lastHasFullUtxoDb = newVal;
    if (prev === null) {
      // First observation. Surface it once so operators can confirm the
      // sidecar booted in the expected mode. Quiet for full mode (the
      // expected steady state); louder for partial.
      if (newVal === true) {
        console.log("[node-status] sidecar reports HAS_FULL_UTXO_DB — full-ledger mode");
      } else {
        console.warn(
          "[node-status] PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG risk: sidecar booted WITHOUT HAS_FULL_UTXO_DB. " +
          "Dapps will silently drop incoming txs from non-tracked senders. " +
          "Restart with a fresh archive snapshot."
        );
      }
      return;
    }
    if (prev === true && newVal === false) {
      console.error(
        "[node-status] PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG triggered: sidecar dropped HAS_FULL_UTXO_DB mid-session " +
        "(likely a Replace fired against an orphan-tail snapshot). Dapps will start silently dropping incoming txs. " +
        "Restart the sidecar with a fresh archive snapshot to recover."
      );
    } else if (prev === false && newVal === true) {
      // Recovery only happens on restart with a good snapshot — but log
      // it anyway in case someone manually intervenes.
      console.log("[node-status] sidecar regained HAS_FULL_UTXO_DB — full-ledger mode restored");
    }
  }

  async function tickNode() {
    if (!nodeRpcUrl) return;
    try {
      const data = await httpsJson("GET", `${nodeRpcUrl}/status`);
      const status = (data && typeof data.node_sync_status === "string")
        ? data.node_sync_status
        : "unknown";
      const peerInfos = (data && Array.isArray(data.peers)) ? data.peers : [];
      const connectedPeers = peerInfos.filter(
        (p) => p && p.connection_status === "Connected",
      );
      let peerBestTipHeight = null;
      for (const p of connectedPeers) {
        const h = p && p.best_tip_height;
        if (typeof h === "number" && (peerBestTipHeight == null || h > peerBestTipHeight)) {
          peerBestTipHeight = h;
        }
      }
      const ourTipHeight = (data && data.blockchain && data.blockchain.best_tip
        && typeof data.blockchain.best_tip.height === "number")
        ? data.blockchain.best_tip.height
        : null;
      if (status === "Synced") hasBeenSynced = true;
      // Parse `node.flags` (e.g. "HAS_FULL_UTXO_DB | HAS_FULL_IDENTITY_DB")
      // for the partial-ledger downgrade signal. Absence means the sidecar
      // is operating in partial mode and the source-null bug is live.
      const flagsStr = (data && data.node && typeof data.node.flags === "string")
        ? data.node.flags
        : "";
      const hasFullUtxoDb = flagsStr.includes("HAS_FULL_UTXO_DB");
      snapshot = {
        status,
        peers: connectedPeers.length,
        bestTipHeight: ourTipHeight,
        peerBestTipHeight,
        error: null,
        hasBeenSynced,
        hasFullUtxoDb,
        at: Date.now(),
      };
      logStatusChange(status, null);
      logFullUtxoDbChange(hasFullUtxoDb);
    } catch (e) {
      snapshot = {
        status: "unreachable",
        peers: 0,
        bestTipHeight: null,
        peerBestTipHeight: null,
        error: e && e.message ? e.message : String(e),
        hasBeenSynced,
        // Don't claim partial mode just because the probe couldn't reach
        // the sidecar — keep the last observed value so a transient
        // network blip doesn't fire a false alarm.
        hasFullUtxoDb: lastHasFullUtxoDb,
        at: Date.now(),
      };
      logStatusChange("unreachable", snapshot.error);
    }
  }

  // Independent block-explorer probe. Hits `/active_chain` (the cheapest
  // endpoint, also used during chain-id discovery) on every configured
  // host in parallel. Caches per-host health into the shared
  // `_explorerHostHealth` table so the proxy and chain pollers automatically
  // pick a healthy host. Latches `explorerHasBeenOk` once any host is
  // healthy so the loaders can apply trust-after-first-ok semantics.
  //
  // Aggregation:
  //   - all hosts ok            → status: "ok"
  //   - some ok, some not       → status: "degraded"  (loaders treat as ok)
  //   - all bad_response        → status: "bad_response"
  //   - otherwise (any down)    → status: "unreachable"
  async function tickExplorer() {
    const hosts = getExplorerUpstreams();
    const upstreamBase = getExplorerUpstreamBase();
    const results = await Promise.all(hosts.map(async (host) => {
      const url = `${explorerProto(host)}://${host}${upstreamBase}/active_chain`;
      const startedAt = Date.now();
      try {
        const data = await httpsJson("GET", url);
        const chainId = (data && typeof data.chain_id === "string") ? data.chain_id : null;
        if (!chainId) {
          return {
            host,
            status: "bad_response",
            chainId: null,
            latencyMs: Date.now() - startedAt,
            error: "missing chain_id in /active_chain response",
            at: Date.now(),
          };
        }
        return {
          host,
          status: "ok",
          chainId,
          latencyMs: Date.now() - startedAt,
          error: null,
          at: Date.now(),
        };
      } catch (e) {
        return {
          host,
          status: "unreachable",
          chainId: null,
          latencyMs: null,
          error: e && e.message ? e.message : String(e),
          at: Date.now(),
        };
      }
    }));

    // Update the shared health table so `pickActiveExplorerUpstream()` /
    // `orderedExplorerUpstreams()` (used by proxy + pollers) see fresh
    // data on the next call.
    for (const info of results) setExplorerUpstreamHealth(info.host, info);

    const okHosts = results.filter((r) => r.status === "ok");
    const allOk = okHosts.length === results.length;
    const anyOk = okHosts.length > 0;
    if (anyOk) explorerHasBeenOk = true;

    let aggStatus;
    if (allOk) aggStatus = "ok";
    else if (anyOk) aggStatus = "degraded";
    else if (results.every((r) => r.status === "bad_response")) aggStatus = "bad_response";
    else aggStatus = "unreachable";

    const active = okHosts[0] || null;
    // Surface a representative error: prefer the first failure on a host
    // we'd otherwise want to use, so the dashboard / loader meta line
    // names the actual problem.
    const firstErr = results.find((r) => r.error);

    explorerSnapshot = {
      status: aggStatus,
      host: active ? active.host : (results[0] ? results[0].host : null),
      activeHost: active ? active.host : null,
      hosts: results,
      chainId: active ? active.chainId : null,
      latencyMs: active ? active.latencyMs : null,
      error: active ? null : (firstErr ? firstErr.error : null),
      at: Date.now(),
    };
    logExplorerStatusChange(aggStatus, explorerSnapshot.error);
  }

  async function tick() {
    await Promise.allSettled([tickNode(), tickExplorer()]);
    fireUpdateListeners();
  }

  function scheduleNext() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    // Self-adapting cadence: tight while the node is still coming up, slow
    // once it's `Synced`. Avoids missing fast `Connecting → Connected`
    // transitions without spamming the sidecar in steady state. When no
    // sidecar is configured we boot off the explorer instead — fast until
    // it has been seen healthy at least once, then slow.
    const inBoot = nodeRpcUrl
      ? snapshot.status !== "Synced"
      : !explorerHasBeenOk;
    const delay = inBoot ? bootIntervalMs : intervalMs;
    timer = setTimeout(() => {
      // Chain the next schedule onto tick completion so a slow /status
      // call can't queue up overlapping requests.
      void tick().then(scheduleNext, scheduleNext);
    }, delay);
  }

  function start() {
    if (started) return;
    started = true;

    if (localDev) {
      snapshot = {
        status: "mock",
        peers: 0,
        bestTipHeight: null,
        peerBestTipHeight: null,
        error: null,
        hasBeenSynced: false,
        hasFullUtxoDb: null,
        at: Date.now(),
      };
      const mockHosts = getExplorerUpstreams();
      explorerSnapshot = {
        status: "mock",
        host: mockHosts[0] || null,
        activeHost: null,
        hosts: mockHosts.map((h) => ({
          host: h, status: "mock", chainId: null,
          latencyMs: null, error: null, at: Date.now(),
        })),
        chainId: null,
        latencyMs: null,
        error: null,
        at: Date.now(),
      };
      lastStatus = "mock";
      lastExplorerStatus = "mock";
      console.log("[node-status] local-dev mode — probe disabled");
      return;
    }

    if (!nodeRpcUrl) {
      // No node URL configured. Node side stays `unknown` forever — the
      // loader treats that as "nothing to wait for". Explorer probe still
      // runs since it's an independent service.
      console.log("[node-status] no NODE_RPC_URL — node probe disabled (status stays 'unknown'); explorer probe still active");
    }

    void tick().then(scheduleNext, scheduleNext);
  }

  function stop() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    started = false;
  }

  function buildSnapshot() {
    return {
      ...snapshot,
      streams: readStreams(),
      explorer: { ...explorerSnapshot },
      explorerHasBeenOk,
    };
  }

  function get() {
    return buildSnapshot();
  }

  function handleRequest(req, res, pathname) {
    if (pathname !== ROUTE) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const body = JSON.stringify(buildSnapshot());
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
      res.end();
      return true;
    }
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }

  return { start, stop, get, handleRequest, registerStream, onUpdate };
}

// ── Dapp-server aggregated status (`/status` page + SSE feed) ───────────────
//
// One per Node process. Aggregates everything the dapp-server already knows
// (node probe, every createAppStateCache, optional per-app pending-send
// queues) into a single JSON snapshot and pushes deltas to connected SSE
// clients in real time.
//
// Routes mounted by `handleRequest`:
//   - GET /__usernode/status         → JSON snapshot (one-shot)
//   - GET /__usernode/status/stream  → SSE; initial snapshot + push on change
//   - GET /status                    → self-contained HTML viewer
//
// The HTML page opens an EventSource against the SSE route and falls back
// to polling /__usernode/status if SSE fails (e.g. proxies that buffer
// text/event-stream aggressively).
//
// Wiring (per process):
//
//     const status = createDappServerStatus({
//       name: "echo",
//       nodeProbe: nodeStatusProbe,
//       localDev: LOCAL_DEV,
//       getBuildVersion: () => buildVersion,
//       port: PORT,
//     });
//     status.registerCache(echoCache);
//     status.registerCache(usernamesCache);
//     status.registerPending("echo", () => echo.getPending());  // optional
//     // ...inside the request handler, before catch-all routes:
//     if (status.handleRequest(req, res, pathname)) return;
//
// All endpoints are public (no secrets exposed — pubkeys/memos are already
// public on chain).

function createDappServerStatus(opts) {
  opts = opts || {};
  const name = opts.name || "dapp-server";
  const nodeProbe = opts.nodeProbe || null;
  const localDev = !!opts.localDev;
  const getBuildVersion = typeof opts.getBuildVersion === "function"
    ? opts.getBuildVersion
    : null;
  const port = opts.port != null ? opts.port : null;
  const startedAtMs = Date.now();
  const debounceMs = opts.debounceMs != null ? opts.debounceMs : 250;
  const safetyTickMs = opts.safetyTickMs != null ? opts.safetyTickMs : 5000;

  // Registered caches and pending-send sources.
  const caches = []; // { cache, unsubscribe }
  const pendingSources = []; // { name, fn }

  // Active SSE response objects. Cleaned up on `close`/`error`.
  const sseClients = new Set();

  let pendingTimer = null;
  function notify() {
    if (pendingTimer != null) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      broadcast();
    }, debounceMs);
    if (pendingTimer.unref) pendingTimer.unref();
  }

  function broadcast() {
    if (sseClients.size === 0) return;
    let payload;
    try {
      payload = `data: ${JSON.stringify(getSnapshot())}\n\n`;
    } catch (e) {
      console.warn(`[${name}-status] snapshot serialize failed: ${e.message}`);
      return;
    }
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch (_) {
        sseClients.delete(res);
      }
    }
  }

  function registerCache(cache) {
    if (!cache) return;
    const unsubscribers = [];
    if (typeof cache.onTxProcessed === "function") {
      unsubscribers.push(cache.onTxProcessed(() => notify()));
    }
    if (typeof cache.onWaiterChange === "function") {
      // Surface bridge SSE waiter open/close immediately so a user
      // clicking "send" appears on /status without waiting for the
      // safety tick.
      unsubscribers.push(cache.onWaiterChange(() => notify()));
    }
    caches.push({
      cache,
      unsubscribe: () => unsubscribers.forEach((u) => { try { u(); } catch (_) {} }),
    });
    notify();
  }

  function registerPending(srcName, fn) {
    if (typeof srcName !== "string" || !srcName) {
      throw new Error("registerPending: name required");
    }
    if (typeof fn !== "function") {
      throw new Error("registerPending: fn required");
    }
    pendingSources.push({ name: srcName, fn });
    notify();
  }

  if (nodeProbe && typeof nodeProbe.onUpdate === "function") {
    nodeProbe.onUpdate(() => notify());
  }

  // Periodic safety push covers timer-based state (Last One Wins countdown,
  // pending-send age timers) that doesn't trigger any of the change-driven
  // notify() paths.
  const safetyTimer = setInterval(() => notify(), safetyTickMs);
  if (safetyTimer.unref) safetyTimer.unref();

  function _safe(fn, fallback) {
    try { return fn(); } catch (_) { return fallback; }
  }

  function getSnapshot() {
    const cacheStats = caches.map(({ cache }) => {
      try {
        return typeof cache.getStats === "function"
          ? cache.getStats()
          : { name: cache.name || "?", error: "cache has no getStats()" };
      } catch (e) {
        return { name: cache.name || "?", error: e && e.message ? e.message : String(e) };
      }
    });

    const pending = pendingSources.map(({ name: pName, fn }) => {
      try {
        const items = fn();
        const list = Array.isArray(items) ? items : [];
        return { name: pName, count: list.length, items: list };
      } catch (e) {
        return {
          name: pName, count: 0, items: [],
          error: e && e.message ? e.message : String(e),
        };
      }
    });

    let nodeSnap = null;
    if (nodeProbe && typeof nodeProbe.get === "function") {
      try { nodeSnap = nodeProbe.get(); } catch (_) { nodeSnap = null; }
    }

    return {
      server: {
        name,
        mode: localDev ? "local-dev" : "production",
        port,
        uptimeMs: Date.now() - startedAtMs,
        startedAt: startedAtMs,
        buildVersion: getBuildVersion ? _safe(getBuildVersion, null) : null,
        cachesCount: caches.length,
        sseClients: sseClients.size,
      },
      node: nodeSnap,
      caches: cacheStats,
      pending,
      at: Date.now(),
    };
  }

  function handleRequest(req, res, pathname) {
    if (pathname === "/__usernode/status/stream") {
      if (req.method !== "GET") return false;
      _handleSse(req, res);
      return true;
    }
    if (pathname === "/__usernode/status") {
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      const body = JSON.stringify(getSnapshot());
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...headers, "Content-Length": Buffer.byteLength(body) });
        res.end();
        return true;
      }
      res.writeHead(200, headers);
      res.end(body);
      return true;
    }
    if (pathname === "/status") {
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      const headers = {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        res.end();
        return true;
      }
      res.writeHead(200, headers);
      res.end(STATUS_PAGE_HTML);
      return true;
    }
    return false;
  }

  function _handleSse(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      // Hint to nginx-style proxies to not buffer the response. SSE is
      // useless if buffered.
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    // Initial snapshot, immediately. Clients shouldn't have to wait for
    // the next change to render anything.
    try {
      res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
    } catch (_) {
      try { res.end(); } catch (_) {}
      return;
    }
    sseClients.add(res);

    const keepAlive = setInterval(() => {
      try { res.write(":keep-alive\n\n"); } catch (_) {}
    }, 15000);
    if (keepAlive.unref) keepAlive.unref();

    let cleanedUp = false;
    function cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      sseClients.delete(res);
      clearInterval(keepAlive);
      try { res.end(); } catch (_) {}
    }
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);
  }

  return {
    name,
    notify,
    registerCache,
    registerPending,
    getSnapshot,
    handleRequest,
  };
}

// Inline HTML for `/status`. Self-contained: no external assets, no build
// step. Reads from the SSE stream with /__usernode/status polling fallback.
// Kept readable rather than minified — operators sometimes view-source
// when debugging.
const STATUS_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dapp Server Status</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b0f16; --fg: #e7edf7; --muted: #a8b3c7;
      --card: #141b26; --border: rgba(255,255,255,0.12);
      --accent: #6ea8fe; --danger: #ff6b6b; --ok: #5dd39e; --warn: #e6a817;
      --soft: rgba(255,255,255,0.04);
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f7f8fb; --fg: #0b1220; --muted: #4b5568;
        --card: #ffffff; --border: rgba(15,23,42,0.12);
        --accent: #2563eb; --danger: #c81e1e; --ok: #0f766e; --warn: #b45309;
        --soft: rgba(15,23,42,0.03);
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      background: var(--bg); color: var(--fg);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 20px 48px; }
    .header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
    h1 { font-size: 20px; margin: 0; font-weight: 600; }
    .conn { font-size: 11px; color: var(--muted); }
    .conn .led { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); margin-right: 5px; vertical-align: middle; }
    .conn.live .led { background: var(--ok); }
    .conn.poll .led { background: var(--warn); }
    .conn.dead .led { background: var(--danger); }
    .header-pill { font-size: 13px; color: var(--muted); margin-bottom: 24px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 14px 0; }
    .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 12px; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 1.6; vertical-align: middle; }
    .badge.ok { background: rgba(93,211,158,0.15); color: var(--ok); }
    .badge.warn { background: rgba(230,168,23,0.15); color: var(--warn); }
    .badge.err { background: rgba(255,107,107,0.18); color: var(--danger); }
    .badge.muted { background: var(--soft); color: var(--muted); }
    .badge.accent { background: rgba(110,168,254,0.18); color: var(--accent); }
    .kv { display: grid; grid-template-columns: 150px 1fr; gap: 4px 12px; font-size: 13px; }
    .kv .label { color: var(--muted); }
    .kv .val { word-break: break-all; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
    th { font-weight: 600; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
    tr:last-child td { border-bottom: none; }
    .mono, code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
    /* Mono cells hold full pubkeys / tx ids — break inside the cell so a
     * single 64-char hash doesn't widen the table past the viewport. */
    td.mono { word-break: break-all; overflow-wrap: anywhere; }
    .sync-bar { width: 100%; height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; margin: 8px 0 4px; }
    .sync-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
    .sync-fill.full { background: var(--ok); }
    details { background: var(--soft); border-radius: 8px; padding: 6px 12px; margin: 8px 0; }
    details[open] { padding-bottom: 12px; }
    summary { cursor: pointer; font-size: 13px; padding: 4px 0; font-weight: 500; user-select: none; }
    summary::marker { color: var(--muted); }
    .summary-meta { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 12px; }
    .empty { color: var(--muted); font-size: 12px; padding: 6px 0; font-style: italic; }
    .arrow { color: var(--muted); margin: 0 4px; }
    .err-text { color: var(--danger); font-size: 12px; margin: 8px 0; }
    .warn-text { color: var(--warn); font-size: 12px; margin: 8px 0; }
    .small { font-size: 11px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <h1 id="serverName">Loading…</h1>
        <div class="header-pill" id="serverMeta"></div>
      </div>
      <div class="conn" id="conn"><span class="led"></span><span id="connText">connecting…</span></div>
    </div>

    <div class="card" id="nodeCard">
      <h2>Node</h2>
      <div id="nodeBody" class="empty">Loading…</div>
    </div>

    <div class="card" id="explorerCard">
      <h2>Explorer</h2>
      <div id="explorerBody" class="empty">Loading…</div>
    </div>

    <div class="card">
      <h2>Caches</h2>
      <div id="cachesBody" class="empty">Loading…</div>
    </div>

    <div class="card" id="pendingCard" style="display:none">
      <h2>Pending Sends (server-initiated)</h2>
      <div id="pendingBody"></div>
    </div>

    <div class="card" id="waitersCard">
      <h2>Client Pending Sends</h2>
      <div class="small" style="margin-bottom:10px">
        Live SSE waiters from dapp clients calling
        <code>sendTransaction(...)</code> — each row is one open connection
        waiting for an inclusion match. Recent completions are kept for
        debugging (matched / timeout / disconnected).
      </div>
      <div id="waitersBody"></div>
    </div>

    <div class="card">
      <h2>Recent Transactions</h2>
      <div class="small" style="margin:-6px 0 10px;color:var(--muted)">
        Last 20 transactions per dapp from each cache's
        in-memory store. Caches are rebuilt from chain history on every
        server restart and grow unbounded while running, so
        <code>total</code> reflects everything seen since boot, not just
        what's shown.
      </div>
      <div id="recentBody" class="empty">Loading…</div>
    </div>

    <div class="small" style="text-align:center;margin-top:18px">
      Updated <span id="lastUpdated">—</span> · live via
      <code>/__usernode/status/stream</code> ·
      JSON at <a href="/__usernode/status" style="color:var(--accent)">/__usernode/status</a>
    </div>
  </div>

  <script>
  (function () {
    "use strict";

    var $ = function (id) { return document.getElementById(id); };

    // ── Formatting helpers ────────────────────────────────────────────────
    // Public keys and tx ids are always shown in full on this page — it's
    // a debugging dashboard, so unambiguous copy-pasteable values matter
    // more than visual density. CSS on td.mono lets them wrap.
    function fullAddr(p) { return p ? String(p) : "—"; }
    function fullId(s) { return s ? String(s) : "—"; }
    function fmtAge(ms) {
      if (ms == null || !isFinite(ms)) return "—";
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + "s";
      var m = Math.floor(s / 60); s = s % 60;
      if (m < 60) return m + "m " + s + "s";
      var h = Math.floor(m / 60); m = m % 60;
      if (h < 24) return h + "h " + m + "m";
      var d = Math.floor(h / 24); h = h % 24;
      return d + "d " + h + "h";
    }
    function fmtNum(n) {
      if (n == null) return "—";
      return Number(n).toLocaleString();
    }
    function fmtTime(ms) {
      if (!ms) return "—";
      try { return new Date(ms).toLocaleTimeString(); } catch (_) { return "—"; }
    }
    function fmtMemo(m) {
      if (m == null) return "";
      var s = String(m);
      // Try JSON parse for compact display
      try {
        var parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object" && parsed.app) {
          return parsed.app + (parsed.type ? "/" + parsed.type : "");
        }
      } catch (_) {}
      return s.length > 40 ? s.slice(0, 40) + "…" : s;
    }
    function readyBadge(ok, label) {
      var cls = ok ? "ok" : "warn";
      var text = ok ? (label || "ready") : (label || "waiting");
      return '<span class="badge ' + cls + '">' + esc(text) + '</span>';
    }
    function esc(s) {
      if (s == null) return "";
      return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function statusBadge(status) {
      var s = String(status || "unknown");
      var cls = "muted";
      if (s === "Synced" || s === "ok") cls = "ok";
      else if (s === "Syncing" || s === "Connected") cls = "accent";
      else if (s === "Connecting" || s === "bad_response" || s === "degraded") cls = "warn";
      else if (s === "unreachable") cls = "err";
      else if (s === "mock") cls = "muted";
      return '<span class="badge ' + cls + '">' + esc(s) + '</span>';
    }

    // ── Preserve <details> open state across re-renders + reloads ────────
    //
    // Every renderer below replaces its body via innerHTML on each SSE /
    // poll frame (~1s cadence). Without intervention any <details> the
    // user collapsed snaps right back to whatever default the renderer
    // picked.
    //
    // The fix is two layers, each dead simple:
    //
    //   1. INTRA-SESSION (live re-renders): before each render, snapshot
    //      the current open state of every tracked <details> from the
    //      live DOM, then after the render re-apply those states. No
    //      event listeners, no race against async toggle events on
    //      <details> — just a synchronous read of the current DOM.
    //
    //   2. CROSS-RELOAD: after every render, mirror the same map to
    //      localStorage. On the very first render after a reload the
    //      DOM is empty, so the snapshot falls back to the persisted
    //      map. Result: collapsed state survives F5 / page navigations.
    //
    // The renderer-emitted "open" attribute only takes effect for ids
    // that didn't exist before (new caches, new pending sources) — those
    // pick up the renderer's default heuristic. Anything we've ever seen
    // before keeps whatever state it had, regardless of whether the user
    // toggled it explicitly or it was just sitting at its default.
    var STORAGE_KEY = "dappStatus.openStates";
    function detailsId(prefix, name) {
      return "ds-" + prefix + "-" + String(name || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
    }
    function loadOpenStatesFromStorage() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        var parsed = JSON.parse(raw);
        return (parsed && typeof parsed === "object") ? parsed : {};
      } catch (_) { return {}; }
    }
    function captureOpenStates() {
      // Always seed from localStorage and let the live DOM win for ids
      // currently rendered. Naively returning DOM-only when DOM is
      // non-empty drops persisted state for ids that haven't appeared
      // yet — e.g. the first SSE frame may not contain pending sources
      // (server hasn't seen any), so the very first render leaves
      // ds-pending-* out of the DOM. When a later frame introduces
      // them, a DOM-only snapshot has no entry to restore them from
      // and the default heuristic snaps them open, clobbering the
      // user's persisted preference. Merging keeps that preference
      // until a render actually writes it.
      var map = loadOpenStatesFromStorage();
      var els = document.querySelectorAll('details[id^="ds-"]');
      for (var i = 0; i < els.length; i++) map[els[i].id] = !!els[i].open;
      return map;
    }
    function restoreOpenStates(map) {
      var els = document.querySelectorAll('details[id^="ds-"]');
      for (var i = 0; i < els.length; i++) {
        var id = els[i].id;
        if (Object.prototype.hasOwnProperty.call(map, id)) {
          els[i].open = map[id];
        }
      }
    }
    // Mirror state into localStorage. We merge three sources, in order:
    //   - existing localStorage  (don't lose long-absent ids)
    //   - the pre-render snapshot (catches user toggles right before an
    //     element disappears from the next render — without this their
    //     last action would be lost when the element vanishes)
    //   - the post-render DOM    (covers ids added by this render that
    //     weren't in the snapshot)
    function persistOpenStates(captured) {
      var saved = loadOpenStatesFromStorage();
      if (captured) {
        for (var k in captured) {
          if (Object.prototype.hasOwnProperty.call(captured, k)) saved[k] = !!captured[k];
        }
      }
      var els = document.querySelectorAll('details[id^="ds-"]');
      for (var i = 0; i < els.length; i++) saved[els[i].id] = !!els[i].open;
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); } catch (_) {}
    }

    // ── Renderers ─────────────────────────────────────────────────────────
    function renderHeader(snap) {
      var srv = snap.server || {};
      $("serverName").textContent = srv.name || "dapp-server";
      var bits = [];
      bits.push(srv.mode || "?");
      if (srv.port != null) bits.push(":" + srv.port);
      bits.push((srv.cachesCount || 0) + " cache" + (srv.cachesCount === 1 ? "" : "s"));
      bits.push("up " + fmtAge(srv.uptimeMs));
      if (srv.buildVersion) bits.push("build " + esc(String(srv.buildVersion)));
      bits.push(srv.sseClients + " viewer" + (srv.sseClients === 1 ? "" : "s"));
      $("serverMeta").textContent = bits.join(" · ");
      $("lastUpdated").textContent = fmtTime(snap.at);
    }

    function renderNode(snap) {
      var n = snap.node;
      var body = $("nodeBody");
      if (!n) {
        body.className = "empty";
        body.textContent = "No node probe wired.";
        return;
      }
      body.className = "";
      var rows = [];
      rows.push('<div class="kv">');
      rows.push('<div class="label">Status</div><div class="val">' + statusBadge(n.status) +
        (n.error ? ' <span class="err-text">' + esc(n.error) + '</span>' : '') + '</div>');
      rows.push('<div class="label">Peers</div><div class="val">' + fmtNum(n.peers) + '</div>');
      rows.push('<div class="label">Best tip</div><div class="val">' +
        (n.bestTipHeight != null ? fmtNum(n.bestTipHeight) : "—") +
        (n.peerBestTipHeight != null ? ' / ' + fmtNum(n.peerBestTipHeight) + ' (peers)' : '') + '</div>');
      var pct = null;
      if (n.bestTipHeight != null && n.peerBestTipHeight != null && n.peerBestTipHeight > 0) {
        pct = Math.max(0, Math.min(100, (n.bestTipHeight / n.peerBestTipHeight) * 100));
      }
      if (pct != null) {
        rows.push('<div class="label">Sync</div><div class="val">' + pct.toFixed(1) + '%' +
          '<div class="sync-bar"><div class="sync-fill' + (pct >= 99.9 ? ' full' : '') + '" style="width:' + pct + '%"></div></div>' +
          '</div>');
      }
      rows.push('<div class="label">First-synced?</div><div class="val">' +
        (n.hasBeenSynced ? '<span class="badge ok">yes</span>' : '<span class="badge warn">not yet</span>') + '</div>');
      if (n.hasFullUtxoDb === false) {
        rows.push('<div class="label">UTXO mode</div><div class="val">' +
          '<span class="badge err">PARTIAL</span> ' +
          '<span class="warn-text">sidecar lacks HAS_FULL_UTXO_DB — incoming txs from non-tracked senders may be silently dropped</span>' +
          '<details id="ds-node-utxo-why" style="margin-top:6px"><summary class="small">Why? (likely cause)</summary>' +
          '<div class="small" style="margin-top:6px;line-height:1.5">' +
          'Most often this is a silent <code>BlockchainSyncAction::Replace</code>: the candidate verifier picks a target chain that doesn&rsquo;t share enough ancestor with the current best chain, ' +
          '<code>replace()</code> clears <code>trees.utxo_root</code>, and from that point every block applies in <code>partial</code> mode because the worker has no full UTXO tree at the new parent root. ' +
          '(Replace actions log at <code>DEBUG</code> by default, so they don&rsquo;t appear in <code>RUST_LOG=info</code>.)' +
          '<br><br>' +
          'A related contributing path is the <code>BlocksApplyWithoutCandidateVerification</code> warning &mdash; peer-fetched blocks reaching the apply pipeline before candidate verification has signed off. ' +
          'Upstream <code>FIXME</code> at ' +
          '<a href="https://github.com/Usernode-Labs/usernode/blob/main/crates/node/src/blockchain/sync/blockchain_sync_reducer.rs#L468" target="_blank" rel="noopener" style="color:var(--accent)">' +
          'crates/node/src/blockchain/sync/blockchain_sync_reducer.rs:468</a>:' +
          '<br><em>&ldquo;ensure peer-origin intermediate sync blocks are ingested through candidate verification before they can enter the apply pipeline.&rdquo;</em>' +
          '<br><br>' +
          'Workaround: restart the sidecar with <code>make node-full</code> to load the archive and get a fresh full-mode window. ' +
          'Confirm with <code>RUST_LOG=&#x27;info,usernode_node::blockchain=debug&#x27;</code> to see <code>BlockchainSyncReplace</code> events directly.' +
          '</div></details>' +
          '</div>');
      } else if (n.hasFullUtxoDb === true) {
        rows.push('<div class="label">UTXO mode</div><div class="val"><span class="badge ok">full</span></div>');
      }
      rows.push('<div class="label">Last refresh</div><div class="val">' + fmtTime(n.at) +
        ' <span class="small">(' + fmtAge(Date.now() - (n.at || Date.now())) + ' ago)</span></div>');
      // Per-stream readiness if probe exposes it
      if (n.streams && Object.keys(n.streams).length) {
        var sBits = [];
        for (var k in n.streams) {
          sBits.push((n.streams[k] ? '<span class="badge ok">' : '<span class="badge warn">') + esc(k) + '</span>');
        }
        rows.push('<div class="label">Streams</div><div class="val">' + sBits.join(' ') + '</div>');
      }
      rows.push('</div>');
      body.innerHTML = rows.join('');
    }

    function renderExplorer(snap) {
      // Explorer state lives under snap.node.explorer because the probe
      // owns both the sidecar /status poll and the explorer /active_chain
      // poll (single snapshot, single endpoint).
      var n = snap.node || null;
      var ex = n && n.explorer ? n.explorer : null;
      var body = $("explorerBody");
      if (!ex) {
        body.className = "empty";
        body.textContent = "No explorer probe wired.";
        return;
      }
      body.className = "";
      var rows = [];

      // Top-line summary (aggregated status, active host, first-ok latch).
      rows.push('<div class="kv">');
      rows.push('<div class="label">Status</div><div class="val">' + statusBadge(ex.status) +
        (ex.error ? ' <span class="err-text">' + esc(ex.error) + '</span>' : '') + '</div>');
      rows.push('<div class="label">Active host</div><div class="val mono">' +
        esc(ex.activeHost || ex.host || "—") + '</div>');
      rows.push('<div class="label">First-ok?</div><div class="val">' +
        (n && n.explorerHasBeenOk
          ? '<span class="badge ok">yes</span>'
          : '<span class="badge warn">not yet</span>') + '</div>');
      rows.push('<div class="label">Last refresh</div><div class="val">' + fmtTime(ex.at) +
        ' <span class="small">(' + fmtAge(Date.now() - (ex.at || Date.now())) + ' ago)</span></div>');
      rows.push('</div>');

      // Per-host table — one row per configured upstream so operators
      // can see at a glance which fallback is currently carrying traffic.
      var hosts = Array.isArray(ex.hosts) ? ex.hosts : [];
      if (hosts.length) {
        rows.push('<div style="margin-top:12px">');
        rows.push('<table><thead><tr>' +
          '<th>Host</th><th>Status</th><th>Chain id</th>' +
          '<th>Latency</th><th>Error</th><th>Last refresh</th>' +
          '</tr></thead><tbody>');
        for (var i = 0; i < hosts.length; i++) {
          var h = hosts[i];
          var isActive = ex.activeHost && h.host === ex.activeHost;
          rows.push('<tr>' +
            '<td class="mono">' + esc(h.host || "—") +
              (isActive ? ' <span class="badge accent">active</span>' : '') + '</td>' +
            '<td>' + statusBadge(h.status) + '</td>' +
            '<td class="mono">' + (h.chainId ? esc(h.chainId) : '—') + '</td>' +
            '<td>' + (h.latencyMs != null ? esc(String(h.latencyMs)) + ' ms' : '—') + '</td>' +
            '<td><span class="small">' + esc(h.error || "") + '</span></td>' +
            '<td><span class="small">' + fmtTime(h.at) + '</span></td>' +
            '</tr>');
        }
        rows.push('</tbody></table></div>');
      }

      body.innerHTML = rows.join('');
    }

    function renderCaches(snap) {
      var caches = snap.caches || [];
      var body = $("cachesBody");
      if (!caches.length) {
        body.className = "empty";
        body.textContent = "No caches registered.";
        return;
      }
      body.className = "";
      var rows = ['<table><thead><tr>',
        '<th>Name</th><th>Pubkey</th><th>Query fields</th>',
        '<th>Cached</th><th>Waiters</th><th>Backfill</th><th>Stream</th>',
        '<th>Node SSE</th><th>Last height</th><th>Null-source</th>',
        '</tr></thead><tbody>'];
      for (var i = 0; i < caches.length; i++) {
        var c = caches[i];
        var ns = c.nodeStream || null;
        var nsCell = '<span class="badge muted">explorer</span>';
        if (ns) {
          var nsParts = [
            ns.sseOpen ? '<span class="badge ok">SSE open</span>' : '<span class="badge warn">SSE closed</span>',
          ];
          if (!ns.trackedOwnerEnsured) nsParts.push('<span class="badge warn">untracked</span>');
          if (ns.backoffMs && ns.backoffMs > 1000 && !ns.sseOpen) nsParts.push('<span class="small">backoff ' + Math.round(ns.backoffMs / 1000) + 's</span>');
          nsCell = nsParts.join(' ');
        }
        var nullCell = '—';
        if (c.nullSource) {
          if (c.nullSource.firstSeen) {
            nullCell = '<span class="badge err">' + c.nullSource.nullSourceCount + '/' + c.nullSource.transferTotalCount + '</span>';
          } else if (c.nullSource.transferTotalCount > 0) {
            nullCell = '<span class="badge ok">0/' + c.nullSource.transferTotalCount + '</span>';
          }
        }
        var waitersCount = c.waitersCount || 0;
        var waitersCell = waitersCount > 0
          ? '<span class="badge accent">' + waitersCount + '</span>'
          : '<span class="small">0</span>';
        rows.push('<tr>',
          '<td><strong>' + esc(c.name) + '</strong></td>',
          '<td class="mono">' + esc(fullAddr(c.appPubkey)) + '</td>',
          '<td><span class="small">' + esc((c.queryFields || []).join(', ')) + '</span></td>',
          '<td>' + fmtNum(c.count) + '</td>',
          '<td>' + waitersCell + '</td>',
          '<td>' + readyBadge(!!c.backfillDone, c.backfillDone ? "done" : "running") + '</td>',
          '<td>' + readyBadge(!!c.streamReady) + '</td>',
          '<td>' + nsCell + '</td>',
          '<td>' + (ns && ns.lastHeight != null ? fmtNum(ns.lastHeight) : '—') + '</td>',
          '<td>' + nullCell + '</td>',
          '</tr>');
      }
      rows.push('</tbody></table>');
      body.innerHTML = rows.join('');
    }

    function renderPending(snap) {
      var srcs = snap.pending || [];
      var card = $("pendingCard");
      var body = $("pendingBody");
      if (!srcs.length) { card.style.display = "none"; return; }
      card.style.display = "";
      var html = "";
      for (var i = 0; i < srcs.length; i++) {
        var src = srcs[i];
        var did = detailsId("pending", src.name);
        // Default for first-ever appearance only; restoreOpenStates
        // overrides this for ids already on the page.
        var openAttr = src.count > 0 ? " open" : "";
        html += '<details id="' + did + '"' + openAttr + '><summary>' + esc(src.name) +
          ' <span class="summary-meta">' + (src.count || 0) + ' pending</span></summary>';
        if (src.error) {
          html += '<div class="err-text">' + esc(src.error) + '</div>';
        } else if (!src.items || !src.items.length) {
          html += '<div class="empty">Nothing in flight.</div>';
        } else {
          html += '<table><thead><tr>' +
            '<th>Id</th><th>Kind</th><th>Counterparty</th><th>Amount</th>' +
            '<th>Status</th><th>Age</th><th>Note</th>' +
            '</tr></thead><tbody>';
          for (var j = 0; j < src.items.length; j++) {
            var it = src.items[j];
            var statusCls = "muted";
            if (/(confirmed|done|ok)/i.test(it.status || "")) statusCls = "ok";
            else if (/(fail|error|reject)/i.test(it.status || "")) statusCls = "err";
            else if (/(pend|wait|in.?flight|echoing|sending|active|in.?progress)/i.test(it.status || "")) statusCls = "accent";
            html += '<tr>' +
              '<td class="mono">' + esc(fullId(it.id)) + '</td>' +
              '<td>' + esc(it.kind || "—") + '</td>' +
              '<td class="mono">' + esc(fullAddr(it.fromOrTo || it.to || it.from)) + '</td>' +
              '<td>' + (it.amount != null ? fmtNum(it.amount) : "—") + '</td>' +
              '<td><span class="badge ' + statusCls + '">' + esc(it.status || "—") + '</span></td>' +
              '<td>' + fmtAge(it.ageMs) + '</td>' +
              '<td><span class="small">' + esc(it.error || it.note || "") + '</span></td>' +
              '</tr>';
          }
          html += '</tbody></table>';
        }
        html += '</details>';
      }
      body.innerHTML = html;
    }

    function waiterFinalBadge(status) {
      var s = String(status || "—");
      var cls = "muted";
      if (s === "matched" || s === "matched-immediate") cls = "ok";
      else if (s === "timeout") cls = "err";
      else if (s === "disconnected") cls = "warn";
      var label = s === "matched-immediate" ? "matched (instant)" : s;
      return '<span class="badge ' + cls + '">' + esc(label) + '</span>';
    }

    function renderWaiters(snap) {
      var caches = snap.caches || [];
      var body = $("waitersBody");
      // Card is always visible (per request) — the body either shows
      // per-cache active+recent tables or a friendly empty state if no
      // client has ever subscribed yet on this server lifetime.
      var hasAny = caches.some(function (c) {
        return (c.waitersCount || 0) > 0 ||
               (c.recentWaitersCount || 0) > 0;
      });
      if (!hasAny) {
        body.innerHTML = '<div class="empty">No client sends recorded yet.</div>';
        return;
      }
      var html = "";
      var now = Date.now();
      for (var i = 0; i < caches.length; i++) {
        var c = caches[i];
        var activeCount = c.waitersCount || 0;
        var recentCount = c.recentWaitersCount || 0;
        if (!activeCount && !recentCount) continue;
        var summaryBits = [];
        if (activeCount) summaryBits.push(activeCount + " waiting");
        if (recentCount) summaryBits.push(recentCount + " recent");
        var did = detailsId("waiters", c.name);
        html += '<details id="' + did + '" open><summary>' + esc(c.name) +
          ' <span class="summary-meta">' + summaryBits.join(" · ") + '</span></summary>';

        // Active waiters
        var ws = c.waiters || [];
        if (activeCount) {
          html += '<div class="small" style="margin:6px 0 4px;font-weight:600">Active</div>';
          html += '<table><thead><tr>' +
            '<th>Age</th><th>Sender</th><th>Memo</th>' +
            '<th>Tx id</th><th>Client</th><th>Timeout</th>' +
            '</tr></thead><tbody>';
          for (var j = 0; j < ws.length; j++) {
            var w = ws[j];
            html += '<tr>' +
              '<td>' + fmtAge(w.ageMs) + '</td>' +
              '<td class="mono">' + esc(fullAddr(w.sender)) + '</td>' +
              '<td><span class="small">' + esc(fmtMemo(w.memoPreview)) + '</span></td>' +
              '<td class="mono">' + esc(fullId(w.txId || w.txIdHash)) + '</td>' +
              '<td class="mono">' + esc(fullId(w.clientId)) + '</td>' +
              '<td><span class="small">' + fmtAge(w.timeoutMs) + '</span></td>' +
              '</tr>';
          }
          html += '</tbody></table>';
          if (activeCount > ws.length) {
            html += '<div class="small" style="margin-top:6px">' +
              (activeCount - ws.length) + ' more active not shown.</div>';
          }
        } else {
          html += '<div class="small" style="margin:6px 0">No active waiters.</div>';
        }

        // Recent (completed) waiters — kept for debugging timeouts and
        // diagnosing slow inclusions.
        var rs = c.recentWaiters || [];
        if (rs.length) {
          html += '<div class="small" style="margin:10px 0 4px;font-weight:600">Recent</div>';
          html += '<table><thead><tr>' +
            '<th>Status</th><th>Ended</th><th>Took</th>' +
            '<th>Sender</th><th>Memo</th><th>Tx id</th><th>Client</th>' +
            '</tr></thead><tbody>';
          for (var k = 0; k < rs.length; k++) {
            var r = rs[k];
            var endedAge = r.endedAt ? (now - r.endedAt) : null;
            html += '<tr>' +
              '<td>' + waiterFinalBadge(r.finalStatus) + '</td>' +
              '<td><span class="small">' + fmtAge(endedAge) + ' ago</span></td>' +
              '<td><span class="small">' + fmtAge(r.durationMs) + '</span></td>' +
              '<td class="mono">' + esc(fullAddr(r.sender)) + '</td>' +
              '<td><span class="small">' + esc(fmtMemo(r.memoPreview)) + '</span></td>' +
              '<td class="mono">' + esc(fullId(r.txId || r.txIdHash)) + '</td>' +
              '<td class="mono">' + esc(fullId(r.clientId)) + '</td>' +
              '</tr>';
          }
          html += '</tbody></table>';
          if (recentCount > rs.length) {
            html += '<div class="small" style="margin-top:6px">' +
              (recentCount - rs.length) + ' older not shown.</div>';
          }
        }

        html += '</details>';
      }
      body.innerHTML = html;
    }

    function renderRecent(snap) {
      var caches = snap.caches || [];
      var body = $("recentBody");
      var any = caches.some(function (c) { return (c.recent || []).length > 0; });
      if (!any) {
        body.className = "empty";
        body.textContent = "No transactions cached yet.";
        return;
      }
      body.className = "";
      var html = "";
      var now = Date.now();
      for (var i = 0; i < caches.length; i++) {
        var c = caches[i];
        var recent = c.recent || [];
        var did = detailsId("recent", c.name);
        var openAttr = i === 0 ? " open" : "";
        html += '<details id="' + did + '"' + openAttr + '><summary>' + esc(c.name) +
          ' <span class="summary-meta">' + recent.length + ' shown · ' + fmtNum(c.count) + ' total</span></summary>';
        if (!recent.length) {
          html += '<div class="empty">No transactions in this cache.</div>';
        } else {
          html += '<table><thead><tr>' +
            '<th>Id</th><th>From</th><th></th><th>To</th><th>Amount</th>' +
            '<th>Memo</th><th>Block</th><th>Age</th>' +
            '</tr></thead><tbody>';
          for (var j = 0; j < recent.length; j++) {
            var t = recent[j];
            var age = t.ts ? (now - t.ts) : null;
            html += '<tr>' +
              '<td class="mono">' + esc(fullId(t.id)) + '</td>' +
              '<td class="mono">' + esc(fullAddr(t.from)) + '</td>' +
              '<td><span class="arrow">→</span></td>' +
              '<td class="mono">' + esc(fullAddr(t.to)) + '</td>' +
              '<td>' + (t.amount != null ? fmtNum(t.amount) : "—") + '</td>' +
              '<td><span class="small">' + esc(fmtMemo(t.memo)) + '</span></td>' +
              '<td>' + (t.blockHeight != null ? fmtNum(t.blockHeight) : '—') + '</td>' +
              '<td>' + fmtAge(age) + '</td>' +
              '</tr>';
          }
          html += '</tbody></table>';
        }
        html += '</details>';
      }
      body.innerHTML = html;
    }

    function render(snap) {
      var openStates = captureOpenStates();
      try {
        renderHeader(snap);
        renderNode(snap);
        renderExplorer(snap);
        renderCaches(snap);
        renderPending(snap);
        renderWaiters(snap);
        renderRecent(snap);
      } catch (e) {
        console.error("[status] render failed:", e);
      }
      restoreOpenStates(openStates);
      persistOpenStates(openStates);
    }

    function setConn(state) {
      var el = $("conn");
      var t = $("connText");
      el.className = "conn " + state;
      if (state === "live") t.textContent = "live";
      else if (state === "poll") t.textContent = "polling (SSE failed)";
      else if (state === "dead") t.textContent = "disconnected";
      else t.textContent = "connecting…";
    }

    // ── Connection: SSE first, polling fallback ───────────────────────────
    var es = null;
    var pollTimer = null;

    function startPolling() {
      setConn("poll");
      if (pollTimer != null) return;
      var fetchOnce = function () {
        fetch("/__usernode/status", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (snap) { if (snap) render(snap); })
          .catch(function (err) {
            setConn("dead");
            console.warn("[status] poll failed:", err && err.message ? err.message : err);
          });
      };
      fetchOnce();
      pollTimer = setInterval(fetchOnce, 3000);
    }

    function startSse() {
      try { es = new EventSource("/__usernode/status/stream"); }
      catch (e) { startPolling(); return; }
      es.onopen = function () { setConn("live"); };
      es.onmessage = function (ev) {
        try { render(JSON.parse(ev.data)); }
        catch (e) { console.warn("[status] bad SSE frame:", e); }
      };
      es.onerror = function () {
        // EventSource auto-reconnects on its own. If the page never reaches
        // 'live' within ~3s, fall back to polling so the page isn't blank.
        // We don't tear down 'es' — if it recovers, onopen will flip the
        // pill back to live.
        setConn("dead");
        if (pollTimer == null) {
          setTimeout(function () {
            if (es && es.readyState !== 1) startPolling();
          }, 3000);
        }
      };
    }

    if (typeof EventSource !== "undefined") startSse();
    else startPolling();
  })();
  </script>
</body>
</html>`;

// ── Path resolution ──────────────────────────────────────────────────────────

function resolvePath(...candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[candidates.length - 1];
}

module.exports = {
  get EXPLORER_UPSTREAM() { return getExplorerUpstream(); },
  get EXPLORER_UPSTREAM_BASE() { return getExplorerUpstreamBase(); },
  DEFAULT_USERNAMES_PUBKEY,
  loadEnvFile,
  readJson,
  httpsJson,
  handleExplorerProxy,
  createMockApi,
  isExplorerConfirmed,
  createChainPoller,
  fetchAllTransactions,
  fetchGenesisAccounts,
  discoverChainInfo,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  createDappServerStatus,
  walletAddTrackedOwner,
  nodeRecentTxByRecipient,
  createNodeRecentTxStream,
  resolvePath,
};
