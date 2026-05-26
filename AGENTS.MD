# Hub – Agent Notes

## Overview
TypeScript Fastify hub that polls a network of oracles, reconciles their reports, aggregates signatures, and exposes read APIs for operators, relayers, and the frontend. Sole public-facing backend service — oracles are internal network participants not exposed to end users.

Entry point `src/server.ts` registers `src/app.ts`, which autoloads infra plugins, then app plugins, then routes.

## Runtime Architecture

### Infra plugins (`src/plugins/infra`)
- `env.ts` — validates and types all env vars via TypeBox (`AppConfig`).
- `hub-keys.ts` — reads `HUB_KEYS_FILE` (JSON), decorates `current` and optional `next` key slots with parsed PEMs and fingerprints.
- `hub-signer.ts` — signs outbound Hub → Oracle HTTP requests via `X-Hub-*` headers (Ed25519/RSA PEM, canonical-string scheme). See **Hub → Oracle Authentication** below.
- `poller.ts` — runs concurrent polling rounds against all oracle URLs with configurable timeout, jitter, and per-oracle error tracking.
- `undici-client.ts` — pooled HTTP JSON clients for oracle polling.
- `knex.ts` — SQLite setup (`better-sqlite3`) and auto-table creation.
- `swagger.ts` — OpenAPI docs at `/docs`.
- `helmet`, `cors`, `rate-limit`, `sensible` — baseline security / DX.

### App plugins (`src/plugins/app`)
- **Oracle service** (`oracle-service.ts`): polls `/api/health` on each oracle for status and relayer fees; polls `/api/orders` from healthy oracles, normalises payloads, runs reconciliation, persists orders and signatures; marks orders `ready-for-relay` once `computeRequiredSignatures()` threshold is met.
- **Indexer**: `orders.repository.ts` — CRUD + pagination over SQLite; `oracle-orders-reconciliation.ts` — enforces identical payloads across oracle responses and selects majority status.
- **QSB contract client** (`qubic/contract-client.ts`): typed decoders for the Qubic smart contract's binary response formats — `decodeGetLockedOrders`, `decodeGetFilledOrders`, `decodeGetConfig`. `queryContractFunction` posts to the Bob Node `/querySmartContract` endpoint, retries on `{ error: "pending" }`, and throws on HTTP errors or unexpected shapes.
- **Events**: `events.repository.ts` stores raw Solana/Qubic events. Producers:
  - Solana WS listener (`listener/solana/ws-solana-listener.ts`) — primary + fallback WS with exponential reconnect.
  - Helius transaction poller (`listener/solana/helius-transaction-poller.ts`) — backfill and resilience.
  - Qubic event poller (`listener/qubic/qubic-event-poller.ts`) — polls `GetLockedOrders` from the Bob Node via the QSB contract client; maps active `LockedOrderEntry` values to `QubicEvent` objects; deduplicates by `orderHash` (K12 digest).
- **Fee estimation** (`fee-estimation/`): Solana estimation from RPC priority fees + rent; Qubic currently fixed fee; aggregates median relayer fees from healthy oracles and applies bridge fee rules.

## Hub → Oracle Authentication
Every request the Hub makes to an Oracle is signed:

1. Hub computes a canonical string: `METHOD\nURL\nhubId=X\ntimestamp=X\nnonce=X\nbodyhash=X\n`
2. Signs it with its Ed25519/RSA private key (`hub-signer.ts`).
3. Attaches headers: `X-Hub-Id`, `X-Key-Id`, `X-Timestamp`, `X-Nonce`, `X-Body-Hash`, `X-Signature` (base64).
4. Oracle's `hub-verifier.ts` `preValidation` hook: validates header schema → checks 60 s timestamp skew → checks nonce replay (SQLite `hub_nonces`) → verifies body hash → verifies signature against the Hub's public key.
5. `X-Key-Id` allows zero-downtime key rotation: oracle accepts `current` and `next` keys simultaneously.
6. Nonces are cleaned up periodically by `hub-nonces-cleaner.ts`.

## Data Model (SQLite)
Tables auto-created by `src/plugins/infra/knex.ts`:
- `orders` — core order fields, `status`, `created_at`.
- `order_signatures` — `(order_id, signature)` unique pairs.
- `events` — Solana/Qubic events keyed by `(signature, type, nonce)`.

## HTTP Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Welcome banner. |
| `GET` | `/api/orders` | Paginated order listing. Filters: `page`, `limit`, `order`, `source`, `dest`, `status[]`, `from`, `to`, `amount_min`, `amount_max`, `created_after`, `created_before`, `id`, `participant[]`. |
| `GET` | `/api/orders/signatures` | Orders that have reached the oracle signature threshold, with their aggregated signatures (used by relayers). |
| `GET` | `/api/orders/events` | Cursor-based pagination over stored Solana/Qubic events. Params: `created_after`, `after_id`, `limit`. |
| `GET` | `/api/orders/trx-hash/:hash` | Order lookup by origin transaction hash, including signatures. |
| `POST` | `/api/orders/estimate` | Fee estimation for a given `{ amount, destination }`. |
| `GET` | `/api/health/bridge` | Bridge pause status `{ paused: boolean }`. |
| `GET` | `/api/health/oracles` | Per-oracle health + relayer fee snapshot. |
| `GET` | `/api/keys` | Hub public keys (`current` + optional `next`). |
| `GET` | `/docs` | Swagger UI (OpenAPI). |

## Config & Ops
Required env vars (see `src/plugins/infra/env.ts`): `SQLITE_DB_FILE`, `PORT`, `HOST`, `ORACLE_URLS`, `ORACLE_SIGNATURE_THRESHOLD`, `ORACLE_COUNT`, `HUB_KEYS_FILE`, `SOLANA_WS_URL`, `SOLANA_FALLBACK_WS_URL`, `SOLANA_LISTENER_ENABLED`, `HELIUS_RPC_URL`, `HELIUS_POLLER_ENABLED`, `HELIUS_POLLER_INTERVAL_MS`, `HELIUS_POLLER_LOOKBACK_SECONDS`, `HELIUS_POLLER_TIMEOUT_MS`, `HELIUS_POLLER_RETRY_DELAY_MS`, `QUBIC_RPC_URL`, `QUBIC_POLLER_ENABLED`, `QUBIC_POLLER_INTERVAL_MS`, `QUBIC_POLLER_TIMEOUT_MS`, `TOKEN_MINT`.

`ORACLE_SIGNATURE_THRESHOLD` is interpreted as a fraction of `ORACLE_COUNT` when in `[0, 1]`, or as an absolute integer otherwise. The helper `computeRequiredSignatures()` in `oracle-service.ts` centralises this logic.

## Testing
Tests live under `test/` and mirror runtime folders (`app/`, `plugins/`, `routes/`). Use the shared Fastify builder in `test/helpers/build.ts` and avoid direct `process.env` access. The in-memory SQLite instance and mocked poller/undici clients are wired up by default. 100% line/branch/function/statement coverage is enforced via `c8`.
