# Hub – Agent Notes

## Overview
TypeScript Fastify service that acts as the bridge aggregator. It listens for on-chain events from Solana and Qubic, persists them, polls oracle nodes for signed order attestations, reconciles consensus, and exposes a public REST API to the frontend and to the oracles.

Responsibilities:
- Ingest Solana program events via WebSocket listener (`ws-solana-listener.ts`) + Helius fallback poller.
- Ingest Qubic events via smart-contract state polling through Bob.
- Persist raw events in SQLite; oracles cursor-poll these via `/api/orders/events`.
- Poll oracle nodes for signed orders; reconcile consensus; mark orders `ready-for-relay` once the signature threshold is met.
- Expose a public REST API (with OpenAPI at `/docs`) for the frontend and for oracle coordination.
- Sign outgoing Hub → Oracle requests with Ed25519 keys.

Entry point `src/server.ts` registers `src/app.ts`, which autoloads infra plugins, then app plugins, then routes.

## Runtime Architecture

### Infra plugins (`src/plugins/infra`)
- `env.ts` — validates config (`AppConfig`); exposes `kConfig` decorator.
- `knex.ts` — SQLite setup (`better-sqlite3`), auto-table creation on `onReady`.
- `hub-keys.ts` — loads the Hub's own Ed25519 signing key pair from `HUB_KEYS_FILE`; exposes `kHubPublicKeys` for the `/api/keys` route.
- `hub-signer.ts` — builds signed `X-Hub-*` headers for outgoing Hub → Oracle requests.
- `poller.ts` — single/fallback HTTP poller with timeout and jitter.
- `exponential-backoff.ts` — generic backoff utility (used by Helius poller).
- `undici-client.ts` — pooled HTTP JSON clients.
- `swagger.ts` — OpenAPI/Swagger UI at `/docs`.
- `helmet`, `cors`, `rate-limit`, `sensible` — baseline security / DX.

### App plugins (`src/plugins/app`)
- **oracle-service.ts** — core hub logic:
  - Polls Oracle `/api/health` (rounds over all oracle URLs) to maintain an in-memory oracle health registry.
  - Polls Oracle `/api/orders` to collect `(orderId, signature)` pairs from each oracle; reconciles orders via `oracle-orders-reconciliation.ts`; writes/updates the Hub's local `orders` table; accumulates signatures in `order_signatures`; marks order `ready-for-relay` once `computeRequiredSignatures()` threshold is met.
  - Preserves oracle-provided intermediate/terminal states such as `transaction-broadcasted` rather than forcing them back to `ready-for-relay`.
- **events/** — raw chain-event layer:
  - `events.repository.ts` — CRUD over `events` table; oracles cursor-poll this via `/api/orders/events`.
  - `solana/solana-events.ts` — decodes + persists Solana program log events; validates with TypeBox schemas.
  - `qubic/qubic-events.ts` — persists Qubic state-derived events. For `unlock`, the event `signature` is the Qubic `orderHash`.
- **fee-estimation/** — fee estimator:
  - `fee-estimation.ts` — orchestrates per-chain cost calculators.
  - `solana-costs-estimation.ts` / `qubic-costs-estimation.ts` — chain-specific compute.
- **indexer/** — order persistence:
  - `orders.repository.ts` — full CRUD over the `orders` and `order_signatures` tables; includes paginated listing with rich filter support.
  - `oracle-orders-reconciliation.ts` — majority-vote logic that picks consensus field values across oracle responses.
- **listener/** — chain event ingestion:
  - `solana/ws-solana-listener.ts` — WebSocket subscription to the Solana QS Bridge program; uses `AsyncQueue` for ordered processing; reconnects with exponential backoff; falls back to `SOLANA_FALLBACK_WS_URL`.
  - `solana/helius-transaction-poller.ts` — Helius enhanced-transaction API poller (periodic catch-up over a configurable lookback window).
  - `qubic/qubic-event-poller.ts` — periodic Qubic state poller using Bob `querySmartContract` (`GetLockedOrders` + `GetFilledOrders`), not Bob log-range crawling.
- **common/** — shared utilities:
  - `validator.ts` — TypeBox `ValidationService` (decorates `kValidation`).
  - `maths.ts` — bigint arithmetic helpers.
  - `schemas/common.ts` — shared TypeBox schema fragments.

## Hub → Oracle Authentication
Every Hub → Oracle request is signed by `hub-signer.ts`:

1. Hub attaches headers: `X-Hub-Id`, `X-Key-Id`, `X-Timestamp` (Unix epoch), `X-Nonce` (random base64), `X-Body-Hash` (SHA-256 hex of request body), `X-Signature` (base64 Ed25519 signature over the canonical string).
2. Canonical string format: `METHOD\nURL\nhubId=X\ntimestamp=X\nnonce=X\nbodyhash=X\n`.
3. The oracle verifies all headers and rejects stale or replayed requests.
4. `X-Key-Id` supports zero-downtime key rotation: oracles accept both `current` and `next` keys; the `/api/keys` route lets oracles pre-fetch the next key before rotation.

## Data Model (SQLite)
Tables auto-created by `src/plugins/infra/knex.ts`:
- `orders` — core order fields: `id`, `source`, `dest`, `from`, `to`, `amount`, `relayerFee`, `origin_trx_hash`, `destination_trx_hash`, `source_nonce`, `source_payload`, `order_era`, `failure_reason_public`, `status`, `created_at`. Statuses now include `transaction-broadcasted`.
- `order_signatures` — `(order_id, signature)` unique pairs accumulated from oracle polls.
- `events` — raw on-chain events: `id`, `signature`, `slot`, `chain`, `type`, `nonce`, `payload`, `created_at`. Unique on `(signature, type, nonce)`.
  - For Qubic `unlock`, `signature` is the `orderHash` and payload nonce may be empty because `GetFilledOrders` only returns hashes.

## Event Ingestion + Oracle Reconciliation Pipeline

```
Solana WS / Helius poller ──► events table ◄── Qubic state poller
                                   │
                            Oracles cursor-poll
                         GET /api/orders/events
                                   │
                          oracle-service.ts
                    polls GET /api/orders (per oracle)
                                   │
                     oracle-orders-reconciliation.ts
                       (majority vote per field)
                                   │
                    orders + order_signatures tables
                                   │
                    threshold met → status: ready-for-relay
                                   │
                        GET /api/orders/signatures
                         (consumed by oracles for relay)
```

## Routes

All routes are public (no auth required from the client side). The Hub signs its own outgoing requests to oracles — incoming requests from oracles or the frontend carry no authentication.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Welcome banner. |
| `GET` | `/api/health/bridge` | Returns `{paused: boolean}` — current bridge pause state. |
| `GET` | `/api/health/oracles` | Oracle health registry: status, timestamp, relayer fee config per oracle. |
| `GET` | `/api/orders` | Paginated order list with filters: `source`, `dest`, `status[]`, `from`, `to`, `amount_min/max`, `created_after/before`, `id`, `participant[]`. |
| `GET` | `/api/orders/signatures` | Orders that have reached the signature threshold, with their collected signatures (polled by oracles to initiate relay). |
| `GET` | `/api/orders/events` | Cursor-based event listing (polled by oracles; use `created_after` + `after_id`). |
| `GET` | `/api/orders/trx-hash/:hash` | Fetch order + signatures by origin transaction hash. |
| `POST` | `/api/orders/estimate` | Fee estimation given amount and direction. |
| `GET` | `/api/keys` | Hub's current (and optional next) public key for oracle signature verification and key rotation. |

OpenAPI/Swagger UI available at `/docs`.

## Config & Ops
Required env vars (see `src/plugins/infra/env.ts`): `SQLITE_DB_FILE`, `PORT`, `HOST`, `ORACLE_URLS` (comma-separated), `ORACLE_SIGNATURE_THRESHOLD`, `ORACLE_COUNT`, `HUB_KEYS_FILE`, `SOLANA_WS_URL`, `SOLANA_FALLBACK_WS_URL`, `SOLANA_LISTENER_ENABLED`, `HELIUS_RPC_URL`, `HELIUS_POLLER_ENABLED`, `HELIUS_POLLER_INTERVAL_MS`, `HELIUS_POLLER_LOOKBACK_SECONDS`, `HELIUS_POLLER_TIMEOUT_MS`, `HELIUS_POLLER_RETRY_DELAY_MS`, `TOKEN_MINT`, `QUBIC_BOB_URL`, `QUBIC_POLLER_ENABLED`, `QUBIC_POLLER_INTERVAL_MS`, `QUBIC_POLLER_TIMEOUT_MS`, `QUBIC_POLLER_SYNC_TO_HEAD_ON_START`.

Key tunables: `POLLER_INTERVAL_MS`, `POLLER_REQUEST_TIMEOUT_MS`, `POLLER_JITTER_MS`, `SOLANA_WS_RECONNECT_BASE_MS`, `SOLANA_WS_RECONNECT_MAX_MS`, `SOLANA_WS_FALLBACK_RETRY_MS`.

`ORACLE_SIGNATURE_THRESHOLD` is a **ratio** (e.g. 0.6) combined with `ORACLE_COUNT` to compute the integer required-signature count via `computeRequiredSignatures()`. This differs from the Oracle service, which uses `ORACLE_SIGNATURE_THRESHOLD` as a plain integer count.

Generated Solana client code lives under `src/clients/js/` — do not hand-edit; regenerate with `npm run idl:codama`.

## Testing
Tests live in `test/` and mirror runtime folders (`app/`, `plugins/`, `routes/`). Use `.env.test` and the shared Fastify builder in `test/helpers/build.ts`. Mock helpers: `undici-client-mock.ts`, `poller-mock.ts`, `hub-signing.ts`. Avoid direct `process.env` access in tests. 100% coverage enforced via `c8`.
