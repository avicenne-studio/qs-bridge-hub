# Hub – Agent Notes

## Overview
- TypeScript Fastify hub that polls a network of oracles, reconciles their reports, aggregates signatures, and exposes read APIs for operators and relayers.
- Entry point `src/server.ts` registers `src/app.ts`, which autoloads infra plugins, app plugins, and routes.
- Emphasis on strict schema validation (TypeBox), safe error handling, and SQLite-backed persistence for auditability.

## Runtime Architecture
- **Infra plugins (`src/plugins/infra`)**
  - `env.ts` loads and validates config.
  - `hub-keys.ts` reads `HUB_KEYS_FILE` and decorates public key material (plus fingerprints).
  - `hub-signer.ts` signs `X-Hub-*` headers for Hub → Oracle requests.
  - `poller.ts` runs concurrent polling rounds with timeouts, jitter, and error reporting.
  - `undici-client.ts` provides pooled HTTP JSON clients.
  - `knex.ts` sets up SQLite and bootstraps tables.
  - `swagger.ts` serves OpenAPI docs under `/docs`.
- **App plugins (`src/plugins/app`)**
  - **Oracle service** (`oracle-service.ts`):
    - Parses `ORACLE_URLS` and tracks in-memory health status.
    - Polls `/api/health` on each oracle to refresh `status`, `timestamp`, and relayer fee info.
    - Polls `/api/orders` from healthy oracles, normalizes payloads, reconciles consensus, persists orders, and stores signatures. Orders are marked `ready-for-relay` once required signature thresholds are met.
  - **Indexer**: `orders.repository.ts` CRUD + pagination over SQLite; `oracle-orders-reconciliation.ts` enforces identical order payloads and majority status selection.
  - **Events**: `events.repository.ts` stores Solana/Qubic events. Producers are:
    - Solana WS listener (`listener/solana/ws-solana-listener.ts`) for program logs (with primary + fallback WS).
    - Helius transaction poller (`listener/solana/helius-transaction-poller.ts`) for backfill and resilience.
    - Qubic event poller (`listener/qubic/qubic-event-poller.ts`).
  - **Fee estimation** (`fee-estimation/*`):
    - Solana estimation uses RPC priority fee estimates + rent constants.
    - Qubic estimation is currently a mocked fixed fee.
    - Aggregates median relayer fees from healthy oracles and applies bridge fee rules.

## Data Model (SQLite)
Tables are auto-created by `src/plugins/infra/knex.ts`:
- `orders`: core order fields, `status`, and `created_at`.
- `order_signatures`: `(order_id, signature)` unique pairs.
- `events`: Solana/Qubic events keyed by `(signature, type, nonce)`.

## HTTP Routes
- `GET /` – welcome banner.
- `GET /api/orders` – paginated listing with filterable query params.
- `GET /api/orders/signatures` – relayable orders with signatures (threshold based).
- `GET /api/orders/events` – cursor-based event pagination.
- `GET /api/orders/trx-hash/:hash` – lookup by origin transaction hash.
- `POST /api/orders/estimate` – fee estimation.
- `GET /api/health/bridge` – bridge status (currently `paused: true`).
- `GET /api/health/oracles` – latest oracle health + relayer fee snapshot.
- `GET /api/keys` – Hub public keys (current + optional next).
- `GET /docs` – Swagger UI.

## Config & Ops
- Required env vars include: `SQLITE_DB_FILE`, `PORT`, `HOST`, `ORACLE_URLS`, `ORACLE_SIGNATURE_THRESHOLD`, `ORACLE_COUNT`, `HUB_KEYS_FILE`, `SOLANA_WS_URL`, `SOLANA_FALLBACK_WS_URL`, `SOLANA_LISTENER_ENABLED`, `HELIUS_RPC_URL`, `HELIUS_POLLER_ENABLED`, `HELIUS_POLLER_INTERVAL_MS`, `HELIUS_POLLER_LOOKBACK_SECONDS`, `HELIUS_POLLER_TIMEOUT_MS`, `HELIUS_POLLER_RETRY_DELAY_MS`, `QUBIC_RPC_URL`, `QUBIC_POLLER_ENABLED`, `QUBIC_POLLER_INTERVAL_MS`, `QUBIC_POLLER_TIMEOUT_MS`, `TOKEN_MINT`.
- `computeRequiredSignatures()` treats thresholds in `[0,1]` as a percentage of `ORACLE_COUNT`, or as an absolute integer otherwise.

## Testing
- Tests live under `test/` and mirror runtime folders.
- Prefer the shared Fastify builder in `test/helpers` and avoid direct `process.env` access in tests.
