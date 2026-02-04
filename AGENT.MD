# AGENT.md

## Overview
- TypeScript Fastify hub that receives data from a network of Qubic/Solana oracles, reconciles their reports, and exposes read APIs for bridge operators.
- Server entry is `src/server.ts`, which loads `src/app.ts`. The app uses `@fastify/autoload` to sequentially wire infra plugins, domain plugins, and route handlers.
- Emphasis on security: strict schema validation via `@fastify/type-provider-typebox`, custom error/404 handlers, Helmet/CORS, rate limiting, and sqlite-backed persistence for auditing oracle consensus.

## Architecture
- **Plugin-driven Fastify app (`src/app.ts`)** – infra plugins (`src/plugins/infra`) run first to install cross-cutting concerns (env validation, helmet, cors, rate limits, sensible defaults, SQLite/Knex connectivity, polling helper, and the Undici HTTP client). Application plugins (`src/plugins/app`) then register domain capabilities (shared schemas, indexer, events, and Solana listener).
- **Hub signing keys (`src/plugins/infra/hub-keys.ts`)** – reads `HUB_KEYS_FILE` (JSON on disk) at startup, validates it with TypeBox, and decorates Fastify with hub keys plus a public-only projection (SHA-256 fingerprints of PEM strings). Access via `fastify.getDecorator(kHubKeys | kHubPublicKeys)`.
- **Hub signer (`src/plugins/infra/hub-signer.ts`)** – exposes `signHeaders(...)` (via `kHubSigner`) which builds the canonical request string, computes the body hash, and signs with Ed25519 using the current private key; used by the oracle polling flows to attach `X-Hub-*` headers.
- **Generic polling helper (`src/plugins/infra/poller.ts`)** – decorates Fastify with a poller service (`kPoller`) that accepts a dependency-injected `fetchOne(server, signal)` and an `onRound` callback. Each round awaits optional jitter, runs requests concurrently via `Promise.allSettled`, enforces per-request `AbortController` timeouts, and forwards only fulfilled typed responses along with round metadata. Defaults live in `poller.defaults` (`intervalMs=POLLER_INTERVAL_MS`, `requestTimeoutMs=700`, `jitterMs=25`).
- **Undici JSON client (`src/plugins/infra/undici-client.ts`)** – provides a small JSON GET client (`kUndiciClient`) backed by per-origin `undici` Pools. Supports configurable connection counts, pipelining, keep-alive/connect timeouts, optional default headers, AbortSignal propagation, JSON parsing, and auto-closes created clients on Fastify shutdown. Defaults are tuned for polling workloads (connections=1, pipelining=1, keepAliveTimeout=10s, keepAliveMaxTimeout=60s, connectTimeout=5s).
- **Oracle service (`src/plugins/app/oracle-service.ts`)** – parses `ORACLE_URLS` (comma-separated HTTP(S) URLs) and tracks `{status,timestamp}` for each oracle in an in-memory registry (`kOracleService`). It polls each oracle's `/api/health` endpoint to keep health data fresh and marks oracles as `down` on failures. It also polls `/api/orders`, normalizes `OracleOrderWithSignature` payloads, reconciles consensus orders, stores them, and accumulates signatures; once `computeRequiredSignatures(ORACLE_SIGNATURE_THRESHOLD, ORACLE_COUNT)` is reached, it marks orders `ready-for-relay` (unless already `finalized`).
- **Indexer domain (`src/plugins/app/indexer`)** – encapsulates oracle order logic.
  - `orders.repository.ts` decorates Fastify with CRUD/pagination helpers that talk to SQLite via Knex; table is auto-created on startup (see `src/plugins/infra/knex.ts`).
  - `oracle-orders-reconciliation.ts` exposes `fastify.oracleOrdersReconciliatior.reconcile()` that enforces identical payloads across oracle reports and picks a consensus status (majority vote, rejects ties).
  - Schemas under `schemas/` describe Qubic / Solana transactions and the normalized `OracleOrder` (string `amount`, string `relayerFee`, optional `source_nonce`, optional `source_payload`, boolean `oracle_accept_to_relay`). `orderFromQubic` and `orderFromSolana` show how to normalize raw chain transactions before persisting; `normalizeBridgeInstruction` is the hook where Solana IX data should be decoded.
- **Solana WS listener (`src/plugins/app/listener/solana/ws-solana-listener.ts`)** – optional WebSocket listener (gated by `SOLANA_LISTENER_ENABLED`) that subscribes to Solana program logs for `qSBGtee9tspoDVmb867Wq6tcR3kp19XN1PbBVckrH7H`, decodes outbound/override-outbound events, and persists them in the events repository.
- **Events repository (`src/plugins/app/events/events.repository.ts`)** – persists decoded Solana events in SQLite with a uniqueness guard on `(signature, type, nonce)`.
- **Routes (`src/routes`)** – home route returns a welcome banner; `/api` namespace holds resource-specific routers.
  - `src/routes/api/orders/index.ts` provides `GET /api/orders` for paginated listing with optional `source/dest` filters, `GET /api/orders/signatures` for relayable order signatures (based on status + signature threshold), and `GET /api/orders/events` for cursor-based event reads. Responses include pagination/cursor metadata; all parameters/responses are validated through TypeBox schemas.
  - `src/routes/api/health/index.ts` exposes lightweight health probes: `GET /api/health/bridge` currently reports `{paused:true}` for the bridge, and `GET /api/health/oracles` streams whatever the oracle service registry returns so oracle URLs/states are sourced exclusively from `ORACLE_URLS`.
  - `src/routes/api/keys/index.ts` exposes `GET /api/keys`, returning only public key material plus SHA-256 fingerprints for operator verification.
- **Process lifecycle (`src/server.ts`)** – builds a Fastify instance with smart logging defaults, registers the app via `fastify-plugin` (so decorators leak to encapsulated scopes), and closes gracefully via `close-with-grace`.

## Database
- SQLite (via `better-sqlite3`) accessed through Knex. File path is set with `SQLITE_DB_FILE` in `.env`. Pool is limited to a single connection to keep locking predictable on embedded storage.
- Bootstrapping: `src/plugins/infra/knex.ts` ensures three tables exist:
  - `orders` with fields `{id, source, dest, from, to, amount, relayerFee, source_nonce, source_payload, oracle_accept_to_relay, status}` and default `status='in-progress'`.
  - `order_signatures` with `{id, order_id, signature}` and a unique `(order_id, signature)` constraint.
  - `events` with `{id, signature, slot, chain, type, nonce, payload, created_at}` and a unique `(signature, type, nonce)` constraint.
- IDs are UUID strings; pagination calculates totals via a window function to keep API responses constant time.
- For deployments, `.env.example` documents minimal variables (port, rate limit, DB path, log level). Docker setups mount `/data/hub.sqlite3`; local dev defaults to `./data/hub.sqlite3`.

## Testing & QA
- All automated tests live under `test/`, mirroring the runtime folders:
  - `test/app` exercises cross-cutting behavior (CORS, rate limiting, error/404 handlers).
  - `test/plugins/indexer` validates repository CRUD, reconciliation logic, and domain schemas/utilities.
  - `test/plugins/poller/poller.test.ts` verifies the poller plugin (success filtering, AbortController timeouts, jitter handling, default settings, and double-start protection).
  - `test/plugins/app/oracle-service.test.ts` focuses on the oracle registry and polling loop (env parsing, HTTPS normalization, mutation helpers, and end-to-end polling of mock oracle `/api/health` endpoints).
  - `test/plugins/infra/undici-client.test.ts` covers the Undici client plugin (header merging, JSON parsing, HTTP error propagation, defaults exposure, and onClose cleanup).
  - `test/plugins/events` and `test/plugins/listener/solana` cover event persistence and Solana log decoding/WS behavior.
  - `test/routes/api` hosts HTTP-level tests; `orders.test.ts` seeds the test DB via the repository and asserts pagination + error logging flows plus `/api/orders/signatures`, `orders-events.test.ts` covers `/api/orders/events`, and `health.test.ts` ensures the public endpoints mirror `fastify.oracleService`.
- Tests use Node's `node:test` `TestContext` assertions (`t.assert.*`) rather than importing `assert` directly, keeping the helper utilities minimal.
- Never import `node:assert` in tests—always call assertions through `t.assert.*` on the provided `TestContext` so failures are scoped correctly.
- Never access `process.env` directly in application tests, and never assign values to it in tests. Use `.env.test` and Fastify config instead.
- `test/helpers/build.ts` exposes `build()` which spins up a Fastify instance with the full plugin stack (using `node:test` contexts for lifecycle management). `npm run test` invokes `tsx --test` through `c8` for coverage.
- **Coverage mandate:** keep the suite at 100% statement/branch/function coverage. When adding a feature, budget time to extend or add tests before merging; coverage gates should fail the CI if the threshold drops.

## Running Locally
- Install deps (`npm install`), allow the `better-sqlite3` build (`npx allow-scripts run`), then run `npm run dev` (uses `tsx` with `.env.local`).
- Production build is `npm run build` followed by `npm start` (runs `dist/server.js`). Docker compose files (`docker-compose.yml` and `.prod`) wrap the same commands with the right env defaults.
- Configuration is `.env`-driven. Required variables include `SQLITE_DB_FILE`, `PORT`, `HOST`, `ORACLE_URLS`, `ORACLE_SIGNATURE_THRESHOLD`, `ORACLE_COUNT`, `HUB_KEYS_FILE`, `SOLANA_WS_URL`, and `SOLANA_LISTENER_ENABLED`. `POLLER_INTERVAL_MS` and `RATE_LIMIT_MAX` have defaults.
- `HUB_KEYS_FILE` points to the on-disk JSON keys file used for Hub→Oracle request signing and the `/api/keys` public key endpoint.

## Web3 / Oracle Context
- Each oracle (Fastify service) submits Solana/Qubic transaction data to the hub. The hub:
  1. Validates payloads and normalizes them into `OracleOrder` objects.
  2. Stores them in SQLite for auditability and recovery.
  3. Uses the reconciliation plugin to ensure multiple oracle views of the same bridge transfer agree before finalizing status.
- Future Solana-specific decoding should be implemented inside `normalizeBridgeInstruction` to prevent malformed instructions from passing through.
- The Solana WS listener decodes outbound/override-outbound events from program logs and persists them for downstream systems via `/api/orders/events`.
- Health monitoring / signature aggregation endpoints can reuse the same plugin/route structure—add shared decorators under `src/plugins/app`, expose read/write endpoints in `src/routes/api`, and back them with new tables created from the Knex plugin (ensuring migrations happen on startup).
