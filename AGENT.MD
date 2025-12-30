# AGENT.md

## Overview
- TypeScript Fastify hub that receives data from a network of Qubic/Solana oracles, reconciles their reports, and exposes read APIs for bridge operators.
- Server entry is `src/server.ts`, which loads `src/app.ts`. The app uses `@fastify/autoload` to sequentially wire infra plugins, domain plugins, and route handlers.
- Emphasis on security: strict schema validation via `@fastify/type-provider-typebox`, custom error/404 handlers, Helmet/CORS, rate limiting, and sqlite-backed persistence for auditing oracle consensus.

## Architecture
- **Plugin-driven Fastify app (`src/app.ts`)** – infra plugins (`src/plugins/infra`) run first to install cross-cutting concerns (env validation, helmet, cors, rate limits, sensible defaults, connectivity helpers like SQLite/Knex, the polling helper, and the Undici HTTP client). Application plugins (`src/plugins/app`) then register domain capabilities (shared schemas plus the indexer domain).
- **Generic polling helper (`src/plugins/infra/poller.ts`)** – decorates Fastify with `fastify.poller`, a minimal poller factory that accepts a dependency-injected `fetcher(server, signal)` and an `onRound` callback. Each round awaits an optional jitter, runs requests concurrently via `Promise.allSettled` (so a single failure does not reject the entire round like `Promise.all` would), enforces per-request `AbortController` timeouts, and forwards only fulfilled typed responses along with round metadata. Recommended defaults live in `fastify.poller.defaults` (`intervalMs=1000`, `requestTimeoutMs=700`, `jitterMs=25`), and the file documents a concise usage example.
- **Undici JSON client (`src/plugins/infra/undici-get-client.ts`)** – provides `fastify.undiciGetClient` for building reusable GET-only clients backed by per-origin `undici` Pools. Supports configurable connection counts, pipelining, keep-alive/connect timeouts, optional default headers, AbortSignal propagation, JSON parsing, and auto-closes created clients on Fastify shutdown. Defaults are tuned for polling workloads (connections=1, pipelining=1, keepAliveTimeout=10s, keepAliveMaxTimeout=60s, connectTimeout=5s).
- **Oracle service (`src/plugins/app/oracle-service.ts`)** – parses the required `ORACLE_URLS` (comma-separated HTTPS URLs) and tracks `{status,timestamp}` for each oracle inside an in-memory registry exposed as `fastify.oracleService`. It also polls each oracle's `/api/health` endpoint via the shared poller + Undici client to keep health data fresh, and marks oracles as `down` whenever HTTP failures/timeouts occur so problems surface in `/api/health/oracles`.
- **Indexer domain (`src/plugins/app/indexer`)** – encapsulates oracle order logic.
  - `orders.repository.ts` decorates Fastify with CRUD/pagination helpers that talk to SQLite via Knex; table is auto-created on startup (see `src/plugins/infra/knex.ts`).
  - `oracle-orders-reconciliation.ts` exposes `fastify.oracleOrdersReconciliatior.reconcile()` that enforces identical payloads across oracle reports and picks a consensus status (majority vote, rejects ties).
  - Schemas under `schemas/` describe Qubic / Solana transactions and the normalized `OracleOrder`. `orderFromQubic` and `orderFromSolana` show how to normalize raw chain transactions before persisting; `normalizeBridgeInstruction` is the hook where Solana IX data should be decoded.
- **Routes (`src/routes`)** – home route returns a welcome banner; `/api` namespace holds resource-specific routers.
  - `src/routes/api/orders/index.ts` provides `GET /api/orders` for paginated listing with optional `source/dest` filters plus a placeholder `GET /api/orders/signatures` that currently returns fixtures until oracle-to-hub signature exchange lands. Responses include pagination metadata; all parameters/responses are validated through TypeBox schemas.
  - `src/routes/api/health/index.ts` exposes lightweight health probes: `GET /api/health/bridge` currently reports `{paused:true}` for the bridge, and `GET /api/health/oracles` streams whatever `fastify.oracleService.list()` reports so oracle URLs/states are sourced exclusively from `ORACLE_URLS`.
- **Process lifecycle (`src/server.ts`)** – builds a Fastify instance with smart logging defaults, registers the app via `fastify-plugin` (so decorators leak to encapsulated scopes), and closes gracefully via `close-with-grace`.

## Database
- SQLite (via `better-sqlite3`) accessed through Knex. File path is set with `SQLITE_DB_FILE` in `.env`. Pool is limited to a single connection to keep locking predictable on embedded storage.
- Bootstrapping: `src/plugins/infra/knex.ts` ensures the `orders` table exists with fields `{id, source, dest, from, to, amount, status}` and default `status='in-progress'`.
- Queries use `rowid` as the numeric `id`. Pagination calculates totals via a window function to keep API responses constant time.
- For deployments, `.env.example` documents minimal variables (port, rate limit, DB path, log level). Docker setups mount `/data/hub.sqlite3`; local dev defaults to `./data/hub.sqlite3`.

## Testing & QA
- All automated tests live under `test/`, mirroring the runtime folders:
  - `test/app` exercises cross-cutting behavior (CORS, rate limiting, error/404 handlers).
  - `test/plugins/indexer` validates repository CRUD, reconciliation logic, and domain schemas/utilities.
  - `test/plugins/poller/poller.test.ts` verifies the poller plugin (success filtering, AbortController timeouts, jitter handling, default settings, and double-start protection).
  - `test/plugins/app/oracle-service.test.ts` focuses on the oracle registry and polling loop (env parsing, HTTPS normalization, mutation helpers, and end-to-end polling of mock oracle `/api/health` endpoints).
  - `test/plugins/infra/undici-get-client.test.ts` covers the Undici GET client plugin (header merging, JSON parsing, HTTP error propagation, defaults exposure, and onClose cleanup).
  - `test/routes/api` hosts HTTP-level tests; `orders.test.ts` seeds the test DB via the repository and asserts pagination + error logging flows as well as the placeholder `/api/orders/signatures` response, while `health.test.ts` ensures the public endpoints mirror `fastify.oraclesHealth`.
- Tests use Node's `node:test` `TestContext` assertions (`t.assert.*`) rather than importing `assert` directly, keeping the helper utilities minimal.
- Never import `node:assert` in tests—always call assertions through `t.assert.*` on the provided `TestContext` so failures are scoped correctly.
- `test/helper.ts` exposes `build()` which spins up a Fastify instance with the full plugin stack (using `node:test` contexts for lifecycle management). `npm run test` invokes `tsx --test` through `c8` for coverage.
- **Coverage mandate:** keep the suite at 100% statement/branch/function coverage. When adding a feature, budget time to extend or add tests before merging; coverage gates should fail the CI if the threshold drops.

## Running Locally
- Install deps (`npm install`), allow the `better-sqlite3` build (`npx allow-scripts run`), then run `npm run dev` (uses `tsx` with `.env.local`).
- Production build is `npm run build` followed by `npm start` (runs `dist/server.js`). Docker compose files (`docker-compose.yml` and `.prod`) wrap the same commands with the right env defaults.
- Configuration is `.env`-driven; `ORACLE_URLS` (comma-separated HTTPS URLs) controls which oracle URLs are tracked and exposed by the oracle service and health endpoints.

## Web3 / Oracle Context
- Each oracle (Fastify service) submits Solana/Qubic transaction data to the hub. The hub:
  1. Validates payloads and normalizes them into `OracleOrder` objects.
  2. Stores them in SQLite for auditability and recovery.
  3. Uses the reconciliation plugin to ensure multiple oracle views of the same bridge transfer agree before finalizing status.
- Future Solana-specific decoding should be implemented inside `normalizeBridgeInstruction` to prevent malformed instructions from passing through.
- Health monitoring / signature aggregation endpoints can reuse the same plugin/route structure—add shared decorators under `src/plugins/app`, expose read/write endpoints in `src/routes/api`, and back them with new tables created from the Knex plugin (ensuring migrations happen on startup).
