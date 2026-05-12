# Last One Wins

A Usernode token game. Players send tokens to the pot address; if the
configured timer (`TIMER_DURATION_MS`, default 8h) elapses without a
new entry, the most recent sender wins the entire pot. The server-side
process pays the winner via the sidecar `/wallet/send` RPC.

Designed to run as a child app inside Usernode Social Vibecoding, but also
works standalone (mobile WebView or desktop QR) when fronted by a node.

## Quick start

```bash
npm install
npm run dev          # mock mode at http://localhost:3000 (2-minute timer)
```

For production:

```bash
cp .env.example .env # fill in APP_PUBKEY, APP_SECRET_KEY
npm start
```

## Layout

```
last-one-wins/
  server.js          Express server: mock API, game state, explorer proxy,
                     static, chain pollers, sidecar status probe, /status.
  game-logic.js      Core state machine + payout logic.
  lib/
    dapp-server.js   Vendored helpers (mock API, chain poller, explorer
                     proxy, env loader, status probe). Source:
                     usernode-dapp-starter.
    tx-match.js      Vendored helper for matching txs to bridge waiters.
  public/
    index.html         UI (single-file HTML/CSS/JS).
    usernode-bridge.js
    usernode-usernames.js
    usernode-loading.js
  Dockerfile         node:22-alpine, port 3000, /health probe.
  .env.example
  CLAUDE.md          App-specific notes for AI tooling.
```

## How it works

```
user → sendTransaction(potAddr, N, {app:"lastwin",type:"entry"})
                  │
                  ▼
       [Usernode Blockchain]
                  │
       recipient poller picks it up
                  │
                  ▼
       game-logic.processTransaction
                  │
       pot += N, lastSender = user, lastEntryTs = now
                  │
       (countdown timer continues; resets on each new entry)
                  │
                  ▼
       timer expires → checkPayout() (every 5s)
                  │
       /wallet/send pot → lastSender (sidecar)
                  │
                  ▼
       [Usernode Blockchain]
                  │
       sender poller catches the payout (or game-logic injects
       a synthetic tx so the round advances immediately)
                  │
                  ▼
       /__game/state shows new round, empty pot
```

Two pollers, one for `recipient` and one for `sender`, both feed the same
deduping handler. The recipient poller drives entries; the sender poller
records the payout (and is the failsafe if the synthetic-tx injection is
lost).

## Memo schema

```js
// user → game (entry)
{ app: "lastwin", type: "entry" }

// user → game (display name)
{ app: "lastwin", type: "set_username", username: "alice" }

// game → winner (payout)
{ app: "lastwin", type: "payout", round: 7, winner: "ut1…" }
```

## Configuration

| Var | Purpose |
| --- | --- |
| `APP_PUBKEY` | The pot's on-chain address (entries destination, payouts source). |
| `APP_SECRET_KEY` | Used to sign outgoing `/wallet/send` calls (payouts and consolidations). |
| `NODE_RPC_URL` | Sidecar URL. Default `http://usernode-node:3000` (compose internal). |
| `TIMER_DURATION_MS` | Countdown duration in ms. Default 28800000 (8h). Ignored in `--local-dev` (uses 2 min). |
| `PORT` | HTTP port (default 3000). |

## Origin

Forked from [`usernode-dapp-starter/examples/last-one-wins`](https://github.com/Usernode-Labs/usernode-dapp-starter)
and adapted into a standalone repo so it can be deployed as an
independently-versioned child app on social-vibecoding.
