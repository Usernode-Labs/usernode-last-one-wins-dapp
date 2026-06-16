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

  // Win streak bonuses: a player who wins consecutive rounds earns an
  // operator-funded bonus on top of the full pot (see "Win Streak Bonuses").
  // The bonus is drawn from the app wallet's own surplus, sent as a separate
  // best-effort tx after the main payout, and never blocks or reduces it.
  const STREAK_BONUS_MIN = 2;        // min consecutive wins to earn a bonus
  const STREAK_BONUS_PCT = 0.10;     // bonus fraction of pot per level beyond 1
  const STREAK_BONUS_MAX_PCT = 0.50; // cap on the bonus fraction

  // TODO: Remove after TIMER_CHANGE_TS + 86400000 (~24h after deploy).
  const TIMER_CHANGE_TS = Date.now();

  const state = {
    roundNumber: 1,
    potBalance: 0,
    lastSender: null,
    lastEntryTs: null,
    timerExpiresAt: null,
    entries: [],
    pastRounds: [],
    payoutInProgress: false,
    // Win streaks (derived from the ordered payout sequence, not persisted).
    streaks: new Map(),   // pubkey → { count, lastWonRound }
    currentStreak: null,  // { winner, count, lastRound } or null before any payout
  };

  // pubkey → { name, ts } — latest set_username per sender wins
  const usernames = new Map();
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

  function resolveUsername(pubkey) {
    if (!pubkey) return null;
    const entry = usernames.get(pubkey);
    return entry ? entry.name : null;
  }

  // Bonus tokens for a given pot/streak. Returns whole tokens; 0 below the
  // minimum streak or when the rounded amount is dust.
  function computeStreakBonus(potAmount, streakCount) {
    if (streakCount < STREAK_BONUS_MIN) return 0;
    const pct = Math.min(STREAK_BONUS_MAX_PCT, (streakCount - 1) * STREAK_BONUS_PCT);
    return Math.round((potAmount || 0) * pct);
  }

  // Derive the winner's streak from the ordered payout sequence. A win counts
  // as consecutive only when it is the immediately following round number for
  // the same winner — robust to out-of-order delivery, matches round advance.
  // Returns the post-win streak count.
  function applyStreak(winner, round) {
    let count;
    if (state.currentStreak && state.currentStreak.winner === winner &&
        round === state.currentStreak.lastRound + 1) {
      count = state.currentStreak.count + 1;
    } else {
      count = 1;
    }
    state.streaks.set(winner, { count, lastWonRound: round });
    state.currentStreak = { winner, count, lastRound: round };
    return count;
  }

  function getStateResponse() {
    const usernameMap = {};
    for (const [addr, v] of usernames) usernameMap[addr] = v.name;

    return {
      roundNumber: state.roundNumber,
      potBalance: state.potBalance,
      lastSender: state.lastSender,
      lastEntryTs: state.lastEntryTs,
      timerDurationMs: getTimerDuration(),
      timeRemainingMs: getTimeRemaining(),
      timerExpired: state.timerExpiresAt != null && Date.now() >= state.timerExpiresAt,
      speedupCost: SPEEDUP_COST,
      speedupDurationMs: getSpeedupDuration(),
      streakBonusMin: STREAK_BONUS_MIN,
      streakBonusPct: STREAK_BONUS_PCT,
      streakBonusMaxPct: STREAK_BONUS_MAX_PCT,
      currentStreak: state.currentStreak ? {
        winner: state.currentStreak.winner,
        winnerName: resolveUsername(state.currentStreak.winner),
        count: state.currentStreak.count,
      } : null,
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
      if (!state.lastEntryTs || tx.ts >= state.lastEntryTs) {
        state.lastSender = tx.from;
        state.lastEntryTs = tx.ts;
        state.timerExpiresAt = tx.ts + getTimerDuration();
      }
      state.entries.push({ from: tx.from, amount, ts: tx.ts, txId: tx.id, kind: "entry" });
      console.log(`[game] entry: ${tx.from.slice(0, 16)}… sent ${amount}, pot=${state.potBalance}, round=${state.roundNumber}`);
    } else if (memo.type === "speedup" && tx.to === appPubkey) {
      const amount = tx.amount || 0;
      if (amount <= 0) return;
      state.potBalance += amount;
      // A valid speed-up (>= SPEEDUP_COST) sets a fresh 30-min fuse; an
      // underfunded speedup memo falls back to a base-duration entry so the
      // tokens are never dropped. Out-of-order guard mirrors the entry path.
      const isSpeedup = amount >= SPEEDUP_COST;
      if (!state.lastEntryTs || tx.ts >= state.lastEntryTs) {
        state.lastSender = tx.from;
        state.lastEntryTs = tx.ts;
        state.timerExpiresAt = tx.ts + (isSpeedup ? getSpeedupDuration() : getTimerDuration());
      }
      state.entries.push({ from: tx.from, amount, ts: tx.ts, txId: tx.id, kind: isSpeedup ? "speedup" : "entry" });
      console.log(`[game] ${isSpeedup ? "speedup" : "entry(speedup-underfunded)"}: ${tx.from.slice(0, 16)}… sent ${amount}, pot=${state.potBalance}, round=${state.roundNumber}`);
    } else if (memo.type === "payout" && tx.from === appPubkey) {
      const round = memo.round || state.roundNumber;
      const winner = memo.winner || tx.to;
      state.pastRounds.push({
        round,
        winner,
        amount: tx.amount || 0,
        payoutTs: tx.ts,
        payoutTxId: tx.id,
        entries: state.entries.slice(-50),
      });
      if (round >= state.roundNumber) {
        // Update the streak before advancing — guarded by the same check so
        // replayed/duplicate payouts don't double-count (seenTxIds also dedups).
        applyStreak(winner, round);
        state.roundNumber = round + 1;
        state.potBalance = 0;
        state.lastSender = null;
        state.lastEntryTs = null;
        state.timerExpiresAt = null;
        state.entries = [];
      }
      console.log(`[game] payout detected: round ${round}, advancing to round ${state.roundNumber}`);
    } else if (memo.type === "bonus" && tx.from === appPubkey) {
      // Streak bonus: record onto the matching past round so history can show
      // "+bonus". Does NOT advance the round or touch pot/timer — only payout does.
      const round = memo.round != null ? memo.round : null;
      const bonusInfo = { amount: tx.amount || 0, streak: memo.streak || 0 };
      for (let i = state.pastRounds.length - 1; i >= 0; i--) {
        if (state.pastRounds[i].round === round) {
          state.pastRounds[i].bonus = bonusInfo;
          break;
        }
      }
      console.log(`[game] streak bonus detected: round ${round}, +${bonusInfo.amount} (streak ${bonusInfo.streak})`);
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

  // Best-effort streak bonus send. Drawn from the app wallet's own surplus,
  // not the pot. Tolerates ConsumedUtxo / single-input failures the same way
  // payouts do (parallel deploys race) — log and skip, never retry/consolidate.
  async function sendBonus(toPkHash, amount, round, streak) {
    const memo = Buffer.from(JSON.stringify({ app: APP_ID, type: "bonus", round, winner: toPkHash, streak, amount })).toString("base64url");
    try {
      const resp = await httpJson("POST", `${nodeRpcUrl}/wallet/send`, {
        from_pk_hash: appPubkey, amount, to_pk_hash: toPkHash, fee: 0, memo,
      });
      if (resp && resp.queued) {
        console.log(`[payout] streak bonus ${amount} to ${toPkHash.slice(0, 16)}… (round ${round}, streak ${streak})`);
        return true;
      }
      console.warn("[payout] bonus send failed (treating as unfunded):", resp);
      return false;
    } catch (e) {
      console.warn("[payout] bonus send error (treating as unfunded):", e.message);
      return false;
    }
  }

  // After a confirmed payout, attempt the operator-funded streak bonus. Fully
  // best-effort: any failure degrades to badge-only recognition in the UI.
  async function maybeSendStreakBonus(winner, round, potAmount) {
    try {
      const entry = state.streaks.get(winner);
      const streakCount = entry ? entry.count : 0;
      if (streakCount < STREAK_BONUS_MIN) return;
      const bonus = computeStreakBonus(potAmount, streakCount);
      if (bonus <= 0) return; // skip dust / zero-amount sends
      const sent = await sendBonus(winner, bonus, round, streakCount);
      if (!sent) return;
      // Inject a synthetic bonus tx so history reflects it immediately.
      const syntheticBonus = {
        from_pubkey: appPubkey,
        destination_pubkey: winner,
        amount: bonus,
        memo: JSON.stringify({ app: APP_ID, type: "bonus", round, winner, streak: streakCount, amount: bonus }),
        created_at: new Date().toISOString(),
        id: `bonus_${round}_${Date.now()}`,
      };
      processTransaction(syntheticBonus);
    } catch (e) {
      console.warn("[payout] streak bonus error:", e.message);
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
    const winner = state.lastSender;
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
      // Mock streak bonus so the streak/bonus cycle is observable in --local-dev.
      const entry = state.streaks.get(winner);
      const streakCount = entry ? entry.count : 0;
      const bonus = computeStreakBonus(amount, streakCount);
      if (streakCount >= STREAK_BONUS_MIN && bonus > 0) {
        const bonusTx = {
          id: crypto.randomUUID(),
          from_pubkey: appPubkey,
          destination_pubkey: winner,
          amount: bonus,
          memo: JSON.stringify({ app: APP_ID, type: "bonus", round, winner, streak: streakCount, amount: bonus }),
          created_at: new Date().toISOString(),
        };
        mockTransactions.push(bonusTx);
        processTransaction(bonusTx);
        console.log(`[payout] mock streak bonus injected: round ${round}, +${bonus} (streak ${streakCount})`);
      }
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
        // Streak bonus is best-effort and runs after the round has advanced;
        // it never blocks or reduces the main payout above.
        await maybeSendStreakBonus(winner, round, amount);
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
    state.roundNumber = 1;
    state.potBalance = 0;
    state.lastSender = null;
    state.lastEntryTs = null;
    state.timerExpiresAt = null;
    state.entries = [];
    state.pastRounds = [];
    state.payoutInProgress = false;
    state.streaks.clear();
    state.currentStreak = null;
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
