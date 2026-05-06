/**
 * Last One Wins — standalone server for Usernode social-vibecoding.
 *
 * Hosts the "Last One Wins" token game:
 *   - Users send N tokens to APP_PUBKEY (memo {"app":"lastwin","type":"entry"})
 *   - Server detects the tx via chain poller (recipient query) and grows the pot
 *   - When TIMER_DURATION_MS elapses with no new entry, the last sender wins
 *   - Server uses the sidecar /wallet/send RPC to pay the pot to the winner
 *   - Server's outgoing chain poller (sender query) records the payout
 *   - Client polls /__game/state to render countdown + pot + recent activity
 *
 * Modes:
 *   node server.js              — production mode (real chain)
 *   node server.js --local-dev  — local dev (mock transaction store, 2-min timer)
 *
 * Auth model: lastwin is public. There is no JWT gate on the HTTP surface —
 * any visitor can load the page and read /__game/state. Transaction signing
 * happens client-side via the bridge: native Usernode channel inside the
 * Flutter WebView (top frame OR iframe-relay), QR fallback in a desktop
 * browser. The server never reads or relies on a platform identity.
 *
 * Env vars:
 *   PORT              — HTTP port (default 3000 — matches platform scaffold)
 *   APP_PUBKEY        — game pot address (required for chain mode)
 *   APP_SECRET_KEY    — secret key for outgoing /wallet/send (required for chain mode)
 *   NODE_RPC_URL      — sidecar URL (default http://usernode-node:3000 inside compose)
 *   TIMER_DURATION_MS — countdown duration in ms (default 86400000 = 24h)
 */

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");

const {
  loadEnvFile,
  handleExplorerProxy,
  createMockApi,
  createAppStateCache,
  createUsernamesCache,
  createNodeStatusProbe,
  createDappServerStatus,
} = require("./lib/dapp-server");
const createLastOneWins = require("./game-logic");

loadEnvFile();

// ── CLI flags ────────────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes("--local-dev");
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ── Game config ──────────────────────────────────────────────────────────────
const APP_PUBKEY = process.env.APP_PUBKEY || "ut1_lastwin_default_pubkey";
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || "";
const NODE_RPC_URL = process.env.NODE_RPC_URL || "http://usernode-node:3000";
const TIMER_DURATION_MS = parseInt(process.env.TIMER_DURATION_MS, 10) || 86400000;

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();

// One hop (Caddy) in front of us.
app.set("trust proxy", 1);

// Health check — used by Docker healthcheck and platform polling.
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Mock API (only --local-dev) ──────────────────────────────────────────────
const mockApi = createMockApi({ localDev: LOCAL_DEV });
app.use((req, res, next) => {
  if (mockApi.handleRequest(req, res, req.path)) return;
  next();
});

// ── Game state endpoint ──────────────────────────────────────────────────────
// Game state is a global, read-only summary of the current round. Per
// conventions, GET routes that don't live under /api/ are public; the data
// here is the same for every viewer, so that's fine.
const game = createLastOneWins({
  appPubkey: APP_PUBKEY,
  appSecretKey: APP_SECRET_KEY,
  nodeRpcUrl: NODE_RPC_URL,
  timerDurationMs: TIMER_DURATION_MS,
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
});
// game.start() runs the payout timer (checks every 5s for an expired round
// and triggers /wallet/send when one is found); chain plumbing (recipient +
// sender pollers, backfill, mock drain) is in gameCache below.
game.start();

const gameCache = createAppStateCache({
  name: "lastwin",
  appPubkey: APP_PUBKEY,
  queryFields: ["recipient", "sender"],
  processTransaction: game.processTransaction,
  handleRequest: game.handleRequest,
  onChainReset(newId, oldId) {
    console.log(`[lastwin] chain reset ${oldId} -> ${newId}, resetting game state`);
    game.reset();
  },
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: NODE_RPC_URL,
});
gameCache.start();

app.use((req, res, next) => {
  if (gameCache.handleRequest(req, res, req.path)) return;
  next();
});

// ── Global usernames cache ───────────────────────────────────────────────────
// Same shared wiring as gameCache, just for the global usernames address.
// Connected lastwin clients (and any other dapp the usernames module is
// loaded into) hit `GET /__usernames/state` instead of independently
// paginating the explorer. Public on purpose: usernames are global,
// identical for every viewer.
const usernamesCache = createUsernamesCache({
  localDev: LOCAL_DEV,
  mockTransactions: LOCAL_DEV ? mockApi.transactions : null,
  nodeRpcUrl: NODE_RPC_URL,
});
usernamesCache.start();

app.use((req, res, next) => {
  if (usernamesCache.handleRequest(req, res, req.path)) return;
  next();
});

// ── Sidecar /status probe (powers /status page node card) ────────────────────
// Polls the sidecar every 2s (fast during boot, slow once Synced) and caches
// the snapshot at /__usernode/node_status. Per-cache stream readiness is
// registered so the status page can show whether each cache's SSE link is
// up — and so usernode-loading.js's streamKey gate works out of the box.
const nodeStatusProbe = createNodeStatusProbe({
  nodeRpcUrl: NODE_RPC_URL,
  localDev: LOCAL_DEV,
});
nodeStatusProbe.registerStream("lastwin", () => gameCache.isStreamReady());
nodeStatusProbe.registerStream("usernames", () => usernamesCache.isStreamReady());
nodeStatusProbe.start();

app.use((req, res, next) => {
  if (nodeStatusProbe.handleRequest(req, res, req.path)) return;
  next();
});

// ── Explorer proxy ───────────────────────────────────────────────────────────
// Proxies /explorer-api/* to the public block explorer so the iframe can
// discover the chain id and (optionally) bypass the bridge for direct reads.
app.use((req, res, next) => {
  if (handleExplorerProxy(req, res, req.path)) return;
  next();
});

// ── Build version ────────────────────────────────────────────────────────────
// A short hash of every file in public/ — surfaced to the client three ways:
//   1. As an X-App-Version response header (visible via curl / DevTools).
//   2. Substituted into __BUILD_VERSION__ placeholders in index.html (when
//      present; today's index.html doesn't use them yet, but a future edit
//      to add ?v=… cache-busters on the bridge <script> tags works without
//      a server change).
//   3. As JSON at /__build (handy for scripted health checks).
// Recomputed on every request in --local-dev so iterating without a server
// restart still flips the version. In production the file set is fixed
// once the server starts, so a single startup compute is enough.
const PUBLIC_DIR = path.join(__dirname, "public");

function computeBuildVersion() {
  const hash = crypto.createHash("sha1");
  let names;
  try { names = fs.readdirSync(PUBLIC_DIR).sort(); } catch (_) { return "unknown"; }
  for (const file of names) {
    if (file.startsWith(".")) continue;
    try {
      const data = fs.readFileSync(path.join(PUBLIC_DIR, file));
      hash.update(file).update(data);
    } catch (_) {}
  }
  return hash.digest("hex").slice(0, 8);
}

const STARTUP_BUILD_VERSION = computeBuildVersion();
function getBuildVersion() {
  return LOCAL_DEV ? computeBuildVersion() : STARTUP_BUILD_VERSION;
}
console.log(`  Build version: ${STARTUP_BUILD_VERSION}`);

// Lightweight build-info endpoint. Public on purpose — it's just a hash.
app.get("/__build", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ version: getBuildVersion(), localDev: LOCAL_DEV });
});

// ── Aggregated dapp-server status (HTML viewer + SSE) ───────────────────────
// Exposes /status (HTML), /__usernode/status (JSON), and
// /__usernode/status/stream (SSE). Operator-facing — public on purpose
// (matches /__usernode/node_status and /__usernames/state).
//
// Mounted after the build-version block because getBuildVersion's body
// references STARTUP_BUILD_VERSION (a `const`, in TDZ until evaluated).
// Mounted before the catch-all HTML shell so /status doesn't fall through
// to the index.html renderer.
const dappServerStatus = createDappServerStatus({
  name: "lastwin",
  nodeProbe: nodeStatusProbe,
  localDev: LOCAL_DEV,
  port: PORT,
  getBuildVersion,
});
dappServerStatus.registerCache(gameCache);
dappServerStatus.registerCache(usernamesCache);
dappServerStatus.registerPending("lastwin", () => game.getPending());

app.use((req, res, next) => {
  if (dappServerStatus.handleRequest(req, res, req.path)) return;
  next();
});

// ── Static assets ────────────────────────────────────────────────────────────
// usernode-bridge.js, usernode-usernames.js, usernode-loading.js, and any
// future CSS/images. These are always served — they're public infrastructure,
// not app data.
//
// Cache strategy: `no-cache` (NOT `no-store`) means the browser MAY keep a
// copy locally but MUST revalidate with the server every time before using
// it. Combined with the ?v=BUILD_VERSION query strings injected into
// index.html (when added), this guarantees that any change to a bridge file
// produces a new URL the browser hasn't seen, bypassing the cache entirely.
app.use(express.static(PUBLIC_DIR, {
  index: false,
  etag: true,
  lastModified: true,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("X-App-Version", getBuildVersion());
  },
}));

// ── HTML shell ───────────────────────────────────────────────────────────────
// Public — anyone can load the page. Wallet operations are signed
// client-side via the bridge (native channel inside the Flutter WebView,
// QR fallback in a desktop browser).

// Render the index.html template with __BUILD_VERSION__ substituted. Cached
// in production (file set is frozen) and re-rendered on each request in
// --local-dev so edits show up without a server restart.
let _indexHtmlCache = null;
let _indexHtmlVersion = null;
function renderIndexHtml() {
  const version = getBuildVersion();
  if (LOCAL_DEV || _indexHtmlCache == null || _indexHtmlVersion !== version) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
    } catch (e) {
      return `<!doctype html><pre>Failed to read index.html: ${e.message}</pre>`;
    }
    _indexHtmlCache = raw.split("__BUILD_VERSION__").join(version);
    _indexHtmlVersion = version;
  }
  return _indexHtmlCache;
}

app.get("*", (_req, res) => {
  // HTML is the entry point. We never want a stale copy: it carries the
  // ?v=BUILD_VERSION cache-busters for the bridge scripts, so an old
  // cached HTML loading a new bridge (or vice-versa) is a real bug.
  res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-App-Version", getBuildVersion());
  res.set("Content-Type", "text/html; charset=utf-8");
  res.send(renderIndexHtml());
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  const timerMinutes = Math.round((LOCAL_DEV ? 120000 : TIMER_DURATION_MS) / 60000);
  console.log(`\nLast One Wins server running at http://localhost:${PORT}`);
  console.log(`  App pubkey:    ${APP_PUBKEY.slice(0, 24)}…`);
  console.log(`  Node RPC:      ${NODE_RPC_URL}`);
  console.log(`  Timer:         ${timerMinutes} minutes`);
  console.log(`  Mode:          ${LOCAL_DEV ? "LOCAL DEV (mock API)" : "production (chain pollers running, public access)"}`);
  console.log(`  Payouts:       ${APP_SECRET_KEY ? "enabled" : "DISABLED (no APP_SECRET_KEY)"}\n`);
});
