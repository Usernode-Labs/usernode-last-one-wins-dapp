/**
 * Last One Wins — shared game logic.
 *
 * Encapsulates game state, transaction processing, payout triggering, and
 * the /__game/state HTTP handler. Used by both the standalone server and
 * the combined examples server.
 */

const APP_ID = "lastwin";

function parseMemo(m) {
  if (m == null) return null;
  try { return JSON.parse(String(m)); } catch (_) { return null; }
}

function extractTimestamp(tx) {
  const candidates = [tx.timestamp_ms, tx.created_at, tx.createdAt, tx.timestamp, tx.time];
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v))
      return v < 10_000_000_000 ? v * 1000 : v;
    if (typeof v === "string" && v.trim()) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

function normalizeTx(tx) {
  if (!tx || typeof tx !== "object") return null;
  return {
    id: tx.tx_id || tx.id || tx.txid || tx.hash || null,
    from: tx.from_pubkey || tx.from || tx.source || null,
    to: tx.destination_pubkey || tx.to || tx.destination || null,
    amount: tx.amount != null ? Number(tx.amount) : 0,
    memo: tx.memo != null ? String(tx.memo) : null,
    ts: extractTimestamp(tx) || Date.now(),
  };
}

function createLastOneWins(opts) {
  const appPubkey = opts.appPubkey || "ut1_lastwin_default_pubkey";
  const appSecretKey = opts.appSecretKey || "";
  const nodeRpcUrl = opts.nodeRpcUrl || "http://localhost:3000";
  const timerDurationMs = opts.timerDurationMs || 14400000;
  const localDev = !!opts.localDev;
  const mockTransactions = opts.mockTransactions || null;

  const MOCK_TIMER_DURATION_MS = 120000;

  // Speed-up action: spend SPEEDUP_COST tokens to set a fresh 30-minute
  // fuse on the current round (see "Speed-Up" in CLAUDE.md).
  const SPEEDUP_COST = 100;
  const SPEEDUP_DURATION_MS = 1800000; // 30 min
  const MOCK_SPEEDUP_DURATION_MS = 30000; // 30s — shorter than the 2-min mock base

  // Dynamic shrinking zone (see "Dynamic Shrinking Zone" spec). The zone is a
  // circle in normalized [0,1]^2 space centered at (0.5, 0.5) whose radius
  // shrinks linearly with round elapsed time. radius(t) is a PURE function of
  // (now - roundStartTs), so it is fully reconstructable from chain data and
  // identical across parallel deploys. It floors at ZONE_MIN_RADIUS (never
  // zero) so the center stays playable and every round can resolve.
  const ZONE_CENTER_X = 0.5;
  const ZONE_CENTER_Y = 0.5;
  const ZONE_START_RADIUS = opts.zoneStartRadius != null ? opts.zoneStartRadius : 0.70;
  const ZONE_MIN_RADIUS = opts.zoneMinRadius != null ? opts.zoneMinRadius : 0.12;
  const ZONE_SHRINK_MS = opts.zoneShrinkMs || timerDurationMs;
  const MOCK_ZONE_SHRINK_MS = 120000; // 2 min — matches the mock base timer

  // TODO: Remove after TIMER_CHANGE_TS + 86400000 (~24h after deploy).
  const TIMER_CHANGE_TS = Date.now();

  const state = {
    roundNumber: 1,
    potBalance: 0,
    lastSender: null,
    lastEntryTs: null,
    timerExpiresAt: null,
    roundStartTs: null,
    entries: [],
    pastRounds: [],
    payoutInProgress: false,
  };

  // pubkey → { name, ts } — latest set_username per sender wins
  const usernames = new Map();
  // pubkey → { x, y, ts } — latest entry/speedup position per sender wins
  const positions = new Map();
  const seenTxIds = new Set();
  let signerConfigured = false;

  function getTimerDuration() {
    return localDev ? MOCK_TIMER_DURATION_MS : timerDurationMs;
  }

  function getSpeedupDuration() {
    return localDev ? MOCK_SPEEDUP_DURATION_MS : SPEEDUP_DURATION_MS;
  }

  function getTimeRemaining() {
    if (state.timerExpiresAt == null) return null;
    return Math.max(0, state.timerExpiresAt - Date.now());
  }

  function getZoneShrinkDuration() {
    return localDev ? MOCK_ZONE_SHRINK_MS : ZONE_SHRINK_MS;
  }

  // Clamp an arbitrary memo value into the normalized [0,1] board space.
  // Returns null when the value isn't a finite number.
  function clampUnit(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(1, Math.max(0, n));
  }

  // Deterministic fallback position derived from the sender pubkey, so a
  // coordinate-less entry (legacy client, or an old speedup) always lands in
  // the same spot for a given address rather than being re-randomized.
  function defaultPosition(pubkey) {
    const crypto = require("crypto");
    const h = crypto.createHash("sha256").update(String(pubkey || "")).digest();
    return {
      x: h.readUInt32BE(0) / 0xffffffff,
      y: h.readUInt32BE(4) / 0xffffffff,
    };
  }

  // Resolve the position carried by an entry/speedup memo, falling back to the
  // deterministic per-pubkey default when x/y are absent or invalid.
  function resolvePosition(memo, tx) {
    const x = clampUnit(memo.x);
    const y = clampUnit(memo.y);
    if (x != null && y != null) return { x, y };
    return defaultPosition(tx.from);
  }

  // Latest-wins per sender, guarded by the same out-of-order check used for
  // usernames/entries: an older tx must not overwrite a newer position.
  function recordPosition(pubkey, pos, ts) {
    const prev = positions.get(pubkey);
    if (!prev || ts >= prev.ts) positions.set(pubkey, { x: pos.x, y: pos.y, ts });
  }

  // radius(t): pure function of round elapsed time. Floors at ZONE_MIN_RADIUS.
  function getZoneRadius(now) {
    if (state.roundStartTs == null) return ZONE_START_RADIUS;
    const dur = getZoneShrinkDuration();
    const elapsed = (now == null ? Date.now() : now) - state.roundStartTs;
    const progress = dur > 0 ? Math.min(1, Math.max(0, elapsed / dur)) : 1;
    return Math.max(ZONE_MIN_RADIUS, ZONE_START_RADIUS - (ZONE_START_RADIUS - ZONE_MIN_RADIUS) * progress);
  }

  function getZone(now) {
    return { centerX: ZONE_CENTER_X, centerY: ZONE_CENTER_Y, radius: getZoneRadius(now) };
  }

  function isInsideZone(pos, zone) {
    if (!pos) return false;
    const dx = pos.x - zone.centerX, dy = pos.y - zone.centerY;
    return Math.sqrt(dx * dx + dy * dy) <= zone.radius;
  }

  // The address that would win right now: the most-recent in-zone sender.
  // Returns null when no sender is inside the zone (caller falls back).
  function computeEligibleWinner(now) {
    const zone = getZone(now);
    let best = null, bestTs = -Infinity;
    for (const [addr, pos] of positions) {
      if (isInsideZone(pos, zone) && pos.ts > bestTs) { best = addr; bestTs = pos.ts; }
    }
    return best;
  }

  function resolveUsername(pubkey) {
    if (!pubkey) return null;
    const entry = usernames.get(pubkey);
    return entry ? entry.name : null;
  }

  function getStateResponse() {
    const usernameMap = {};
    for (const [addr, v] of usernames) usernameMap[addr] = v.name;

    const now = Date.now();

    // Latest position per sender, capped to the most recent ~50 to bound the
    // payload (same window as `entries`).
    const positionMap = {};
    const recentPositions = [...positions.entries()]
      .sort((a, b) => b[1].ts - a[1].ts)
      .slice(0, 50);
    for (const [addr, p] of recentPositions) positionMap[addr] = { x: p.x, y: p.y };

    return {
      roundNumber: state.roundNumber,
      potBalance: state.potBalance,
      lastSender: state.lastSender,
      lastEntryTs: state.lastEntryTs,
      roundStartTs: state.roundStartTs,
      timerDurationMs: getTimerDuration(),
      timeRemainingMs: getTimeRemaining(),
      timerExpired: state.timerExpiresAt != null && now >= state.timerExpiresAt,
      speedupCost: SPEEDUP_COST,
      speedupDurationMs: getSpeedupDuration(),
      zone: getZone(now),
      zoneConfig: {
        centerX: ZONE_CENTER_X,
        centerY: ZONE_CENTER_Y,
        startRadius: ZONE_START_RADIUS,
        minRadius: ZONE_MIN_RADIUS,
        shrinkMs: getZoneShrinkDuration(),
      },
      positions: positionMap,
      eligibleWinner: state.lastSender ? computeEligibleWinner(now) : null,
      entries: state.entries.slice(-50).reverse(),
      pastRounds: state.pastRounds.slice(-20).reverse(),
      payoutInProgress: state.payoutInProgress,
      appPubkey,
      usernames: usernameMap,
    };
  }

  // Snapshot of in-flight server-side operations for /__usernode/status.
  // Lastwin only has one such operation at a time: the active payout.
  // Shape matches createDappServerStatus.registerPending() contract:
  //   [{ id, kind, fromOrTo, amount, status, ageMs, error?, note? }, ...]
  function getPending() {
    if (!state.payoutInProgress) return [];
    return [{
      id: "round-" + state.roundNumber,
      kind: "payout",
      fromOrTo: state.lastSender,
      amount: state.potBalance,
      status: "in-progress",
      ageMs: state.lastEntryTs ? Date.now() - state.lastEntryTs : null,
      note: "round " + state.roundNumber + " → winner",
    }];
  }

  function processTransaction(rawTx) {
    const tx = normalizeTx(rawTx);
    if (!tx || !tx.id || !tx.from || !tx.to) return;
    if (seenTxIds.has(tx.id)) return;
    seenTxIds.add(tx.id);

    // Accept txs sent TO the app (entries) or FROM the app (payouts)
    if (tx.to !== appPubkey && tx.from !== appPubkey) return;

    const memo = parseMemo(tx.memo);
    if (!memo || memo.app !== APP_ID) return;

    if (memo.type === "set_username" && tx.to === appPubkey) {
      const raw = String(memo.username || "").trim();
      if (raw) {
        const prev = usernames.get(tx.from);
        if (!prev || tx.ts >= prev.ts) {
          usernames.set(tx.from, { name: raw, ts: tx.ts });
        }
      }
      return;
    }

    if (memo.type === "entry" && tx.to === appPubkey) {
      const amount = tx.amount || 0;
      if (amount <= 0) return;
      state.potBalance += amount;
      const pos = resolvePosition(memo, tx);
      recordPosition(tx.from, pos, tx.ts);
      // roundStartTs is the EARLIEST entry of the round, regardless of arrival
      // order — keeps radius(t) deterministic under out-of-order backfill.
      if (state.roundStartTs == null || tx.ts < state.roundStartTs) state.roundStartTs = tx.ts;
      if (!state.lastEntryTs || tx.ts >= state.lastEntryTs) {
        state.lastSender = tx.from;
        state.lastEntryTs = tx.ts;
        state.timerExpiresAt = tx.ts + getTimerDuration();
      }
      state.entries.push({ from: tx.from, amount, ts: tx.ts, txId: tx.id, kind: "entry", x: pos.x, y: pos.y });
      console.log(`[game] entry: ${tx.from.slice(0, 16)}… sent ${amount}, pot=${state.potBalance}, round=${state.roundNumber}`);
    } else if (memo.type === "speedup" && tx.to === appPubkey) {
      const amount = tx.amount || 0;
      if (amount <= 0) return;
      state.potBalance += amount;
      const pos = resolvePosition(memo, tx);
      recordPosition(tx.from, pos, tx.ts);
      if (state.roundStartTs == null || tx.ts < state.roundStartTs) state.roundStartTs = tx.ts;
      // A valid speed-up (>= SPEEDUP_COST) sets a fresh 30-min fuse; an
      // underfunded speedup memo falls back to a base-duration entry so the
      // tokens are never dropped. Out-of-order guard mirrors the entry path.
      const isSpeedup = amount >= SPEEDUP_COST;
      if (!state.lastEntryTs || tx.ts >= state.lastEntryTs) {
        state.lastSender = tx.from;
        state.lastEntryTs = tx.ts;
        state.timerExpiresAt = tx.ts + (isSpeedup ? getSpeedupDuration() : getTimerDuration());
      }
      state.entries.push({ from: tx.from, amount, ts: tx.ts, txId: tx.id, kind: isSpeedup ? "speedup" : "entry", x: pos.x, y: pos.y });
      console.log(`[game] ${isSpeedup ? "speedup" : "entry(speedup-underfunded)"}: ${tx.from.slice(0, 16)}… sent ${amount}, pot=${state.potBalance}, round=${state.roundNumber}`);
    } else if (memo.type === "payout" && tx.from === appPubkey) {
      const round = memo.round || state.roundNumber;
      state.pastRounds.push({
        round,
        winner: memo.winner || tx.to,
        amount: tx.amount || 0,
        payoutTs: tx.ts,
        payoutTxId: tx.id,
        entries: state.entries.slice(-50),
      });
      if (round >= state.roundNumber) {
        state.roundNumber = round + 1;
        state.potBalance = 0;
        state.lastSender = null;
        state.lastEntryTs = null;
        state.timerExpiresAt = null;
        state.roundStartTs = null;
        state.entries = [];
        positions.clear();
      }
      console.log(`[game] payout detected: round ${round}, advancing to round ${state.roundNumber}`);
    }
  }

  // ── Node RPC helpers ─────────────────────────────────────────────────────

  function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const transport = url.protocol === "https:" ? require("https") : require("http");
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
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
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

  async function configureSigner() {
    if (!appSecretKey) return false;
    try {
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/signer`, { secret_key: appSecretKey });
      if (resp && resp.ok) { console.log("[payout] signer configured"); return true; }
      console.error("[payout] signer config failed:", resp);
      return false;
    } catch (e) {
      console.error("[payout] signer config error:", e.message);
      return false;
    }
  }

  async function sendPayout(toPkHash, amount, round) {
    const memo = Buffer.from(JSON.stringify({ app: APP_ID, type: "payout", round, winner: toPkHash })).toString("base64url");
    try {
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/send`, {
        from_pk_hash: appPubkey, amount, to_pk_hash: toPkHash, fee: 0, memo,
      });
      if (resp && resp.queued) {
        console.log(`[payout] sent ${amount} to ${toPkHash.slice(0, 16)}… (round ${round})`);
        return true;
      }
      console.error("[payout] send failed:", resp);
      return false;
    } catch (e) {
      console.error("[payout] send error:", e.message);
      return false;
    }
  }

  async function consolidateUtxos() {
    try {
      await httpJson("POST", `${nodeRpcUrl}/wallet/send`, {
        from_pk_hash: appPubkey, amount: state.potBalance, to_pk_hash: appPubkey, fee: 0,
        memo: Buffer.from(JSON.stringify({ app: APP_ID, type: "consolidate" })).toString("base64url"),
      });
      console.log("[payout] UTXO consolidation sent");
      return true;
    } catch (e) {
      console.warn("[payout] consolidation failed:", e.message);
      return false;
    }
  }

  // ── Payout check ─────────────────────────────────────────────────────────

  async function checkPayout() {
    if (state.payoutInProgress) return;
    if (!state.lastSender || !state.lastEntryTs) return;
    if (getTimeRemaining() > 0) return;

    // TODO: Remove after TIMER_CHANGE_TS + 86400000 (~24h after deploy).
    // Suppress payout for pre-deploy entries so the 8h→4h timer change
    // doesn't expire an active round prematurely. Re-stamped on every boot,
    // so it generically protects any base-duration cutover. Once a new entry
    // arrives, lastEntryTs updates to post-deploy and this guard no longer fires.
    if (state.lastEntryTs < TIMER_CHANGE_TS) return;

    state.payoutInProgress = true;
    // Winner is the most-recent in-zone sender. When the zone has emptied
    // (no sender inside), fall back to lastSender so the pot is never stranded.
    let winner = computeEligibleWinner(Date.now());
    if (!winner) {
      console.log("[payout] zone empty at expiry — falling back to lastSender");
      winner = state.lastSender;
    }
    const amount = state.potBalance;
    const round = state.roundNumber;
    console.log(`[payout] timer expired! Winner: ${winner.slice(0, 16)}…, pot: ${amount}, round: ${round}`);

    if (localDev && mockTransactions) {
      const crypto = require("crypto");
      const payoutTx = {
        id: crypto.randomUUID(),
        from_pubkey: appPubkey,
        destination_pubkey: winner,
        amount,
        memo: JSON.stringify({ app: APP_ID, type: "payout", round, winner }),
        created_at: new Date().toISOString(),
      };
      mockTransactions.push(payoutTx);
      processTransaction(payoutTx);
      console.log(`[payout] mock payout injected for round ${round}`);
      state.payoutInProgress = false;
      return;
    }

    try {
      if (!signerConfigured) {
        signerConfigured = await configureSigner();
        if (!signerConfigured) { state.payoutInProgress = false; return; }
      }
      let sent = await sendPayout(winner, amount, round);
      if (!sent) {
        console.log("[payout] direct send failed, attempting UTXO consolidation...");
        await consolidateUtxos();
        await new Promise((r) => setTimeout(r, 10000));
        sent = await sendPayout(winner, amount, round);
      }
      if (sent) {
        const syntheticTx = {
          from_pubkey: appPubkey,
          destination_pubkey: winner,
          amount,
          memo: JSON.stringify({ app: APP_ID, type: "payout", round, winner }),
          created_at: new Date().toISOString(),
          id: `payout_${round}_${Date.now()}`,
        };
        processTransaction(syntheticTx);
      } else {
        console.error(`[payout] failed to send payout for round ${round}`);
      }
    } catch (e) {
      console.error("[payout] unexpected error:", e.message);
    } finally {
      state.payoutInProgress = false;
    }
  }

  // ── HTTP handler for /__game/state ───────────────────────────────────────

  function handleRequest(req, res, pathname) {
    if (pathname === "/__game/state" && (req.method === "GET" || req.method === "HEAD")) {
      const body = JSON.stringify(getStateResponse());
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) });
        return res.end(), true;
      }
      res.writeHead(200, headers);
      res.end(body);
      return true;
    }
    return false;
  }

  // ── Start background loops ───────────────────────────────────────────────

  function start() {
    setInterval(checkPayout, 5000);
    // Chain plumbing (live polling, backfill, mock-drain) is owned by the
    // surrounding createAppStateCache wiring in server.js.
  }

  function reset() {
    seenTxIds.clear();
    usernames.clear();
    positions.clear();
    state.roundNumber = 1;
    state.potBalance = 0;
    state.lastSender = null;
    state.lastEntryTs = null;
    state.timerExpiresAt = null;
    state.roundStartTs = null;
    state.entries = [];
    state.pastRounds = [];
    state.payoutInProgress = false;
    signerConfigured = false;
    console.log("[game] state reset (chain restart detected)");
  }

  return {
    state,
    processTransaction,
    handleRequest,
    getStateResponse,
    getPending,
    checkPayout,
    start,
    reset,
    appPubkey,
  };
}

module.exports = createLastOneWins;
