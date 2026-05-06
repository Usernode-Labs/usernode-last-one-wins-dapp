# Last One Wins — notes for Claude Code

A token game on the Usernode chain. Players send tokens to a shared pot
address; if the configured timer (`TIMER_DURATION_MS`, default 24h) elapses
without a new entry, the most recent sender wins the entire pot. The
server-side process pays the winner via the sidecar `/wallet/send` RPC.

This app runs as a child app inside Usernode Social Vibecoding. Read the
authoritative platform conventions before making changes:

**Platform conventions (always current):**
https://usernode.evanshapiro.dev/claude.md

If a rule below this line conflicts with the hosted conventions, the hosted
conventions win.

## Architecture

- `server.js` — Express server. Mock API (--local-dev), game state endpoint,
  explorer proxy, static `public/`, dual chain pollers. No auth middleware
  (lastwin is public — see "Auth model" below).
- `game-logic.js` — Core state machine: dedups incoming tx, tracks the
  countdown timer, calls the sidecar `/wallet/send` when the timer expires,
  exposes `/__game/state`. Also handles `set_username` memos to resolve
  pubkeys → display names in the state response.
- `lib/dapp-server.js` — Vendored helpers (mock API, chain poller, explorer
  proxy, env loader, status probe, status page). Copied from
  `usernode-dapp-starter`; do not edit in-place — re-vendor from upstream
  when fixes land there.
- `lib/tx-match.js` — Vendored helper used by `lib/dapp-server.js` for
  matching transactions against bridge waiters. Same re-vendor rule.
- `public/` — Single-file HTML/JS UI plus the shared `usernode-bridge.js`,
  `usernode-usernames.js`, and `usernode-loading.js`. The bridge and loader
  are shared infrastructure; do not fork them per-app.

## Running locally

```bash
npm install
npm run dev          # mock mode, http://localhost:3000, 2-minute timer
npm start            # production mode (requires .env)
```

## Auth model

Last One Wins is **public**. There is no JWT, no platform login required,
no `req.user` consulted anywhere. The HTTP surface is read-only from the
client's perspective (`/__game/state`, `/__usernames/state`, `/status`).
Wallet operations are signed two different ways:

- **Client → game (entries, set_username)**: signed client-side via
  `usernode-bridge.js`, which has three modes and picks one automatically:
  - **Native (top frame in Flutter WebView)** — the Usernode mobile app
    injects a `Usernode` JS channel on every loaded page (see
    `flutter-mobile-app/lib/features/dapps/dapp_webview_screen.dart`,
    `addJavaScriptChannel('Usernode', …)` on the `WebViewController`). The
    bridge detects this with `!!window.Usernode` and routes
    `sendTransaction` / `signMessage` through the channel.
  - **Iframe-relay (lastwin embedded inside another page that has the
    native channel — e.g. dapp-starter loaded inside the WebView)** — the
    bridge posts a `discover` message to `window.parent`; if the parent
    ACKs, the child flips into relay mode and round-trips its native calls
    through the parent's `Usernode.postMessage`.
  - **QR fallback (desktop browser, no native channel anywhere in the
    frame stack)** — `sendTransaction` shows a QR code for the user to
    scan with the Usernode mobile app, then polls for inclusion.
- **Game → winner (payouts)**: signed server-side by `APP_SECRET_KEY`
  against the sidecar `/wallet/signer` + `/wallet/send` RPC. The secret
  never leaves the server process and is never returned via the API.

## Memo schema

Memos are JSON. Last One Wins only acts on these:

- `user → game (entry)`:    `{"app":"lastwin","type":"entry"}`
- `user → game (username)`: `{"app":"lastwin","type":"set_username","username":"<name>"}`
- `game → winner (payout)`: `{"app":"lastwin","type":"payout","round":<n>,"winner":"<addr>"}`
- `game → game (consolidate)`: `{"app":"lastwin","type":"consolidate"}` (UTXO
  consolidation self-send when a single-UTXO payout fails — see "UTXO
  consolidation" below).

## Sidecar dependency

In production lastwin calls `POST /wallet/tracked_owner/add` and
`POST /wallet/signer` against the social-vibecoding `usernode-node`
sidecar at startup, then `POST /wallet/send` for each payout. Both are
idempotent; `lib/dapp-server.js` will retry transient failures from the
catchup tick. The wiring matches echo's: no `--wallet-owner` flag is
needed on the sidecar.

## Direct-to-node live tail (opt-in)

Set `USE_NODE_STREAM=1` in `.env` to bypass the explorer's 5–60s indexing
lag for live transaction delivery. The cache replaces the explorer poller
for the `recipient` queryField with `createNodeRecentTxStream` (SSE +
catch-up poll against the sidecar's `/transactions/stream` and
`/transactions/by_recipient` endpoints). Backfill and the `sender`
queryField still go through the explorer. Off by default — needs a
sidecar usernode build that exposes those endpoints.

## App-specific conventions

- The pot address is a real on-chain wallet. The server holds
  `APP_SECRET_KEY` so it can sign payouts when the timer expires; the
  funds in the pot are the actual entries received from players, plus
  whatever the operator seeds it with.
- UTXO consolidation: the chain's wallet RPC currently only supports
  single-input transactions, so when the pot is spread across many small
  UTXOs the direct payout fails. `game-logic.js` handles this by sending
  a self-send for the full pot balance (merging UTXOs into one output),
  waiting ~10s, then retrying the payout. See `consolidateUtxos()` in
  `game-logic.js`.
- After a successful RPC payout, `game-logic.js` injects a synthetic
  payout transaction into `processTransaction()` so the round advances
  immediately rather than waiting for the sender poller to catch up.
- `--local-dev` mode skips real RPC entirely and just appends the
  synthetic payout to the mock store; the timer is also shortened to
  2 minutes to make the cycle observable.
- Memo size is well under the 1024-byte chain limit; keep it that way.
- `/__game/state` is intentionally public. It exposes a global summary
  that is the same for every viewer.

## Parallel deploys + same APP_PUBKEY

Both this repo and `usernode-dapp-starter`'s combined examples server
deploy independently and (for now) share the same `APP_PUBKEY`. When the
timer expires, both servers may race to call `/wallet/send` — the first
wins, the second hits `ConsumedUtxo` and aborts. This is the same
race-tolerance pattern as parallel echo deploys. If you need stricter
single-payer semantics later, route payouts through one designated server
or move them to a leader-elected sidecar service.
