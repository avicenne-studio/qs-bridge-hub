# Qubic Solana Bridge Hub

## Overview

The Hub is a data aggregator for the Qubic <-> Solana bridge, collecting and consolidating data from the Oracles network.

## Prerequisites

Using **Docker** is the default way to run the Hub.

If you prefer running it directly on your machine (optional), you need:

* Node.js 24+

## Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Set `SQLITE_DB_FILE` to the database path.

* **Docker (default):** `/data/hub.sqlite3` (stored in a persistent Docker volume)
* **Local Node.js (optional):** `./data/hub.sqlite3` inside the repository

The Hub creates the SQLite database automatically on first launch.

### Configuration Reference

Key environment variables (see `.env.example` for the full list):

* `NODE_ENV`: must be `production` (used by runtime defaults).
* `SQLITE_DB_FILE`: SQLite file path.
* `HOST` / `PORT`: API bind host/port.
* `ORACLE_URLS`: comma-separated list of oracle base URLs.
* `ORACLE_SIGNATURE_THRESHOLD`: minimum oracle signatures required.
* `HUB_KEYS_FILE`: JSON file path containing hub signing keys.
* `RATE_LIMIT_MAX`: per-window request limit (keep low in tests).

## Security: Hub Identity & Key Rotation

Oracles verify Hub identity.
You can access `GET /api/keys`, which returns the hub id plus public key material (current + optional next) and SHA-256 fingerprints. The Hub signs every outbound oracle poll request using the `HUB_KEYS_FILE` JSON (`hubId`, `current`, optional `next`) so oracles can validate the signature and plan ahead for rotations.

When rotating keys, publish the new key under `next`, roll it out to oracles, then promote it to `current` once all oracles trust it.

Generate a new key pair (prints JSON payload):

```bash
npm run generate-key-pair
```

Derive a public key from a private key PEM:

```bash
npm run generate-public-key -- ./path/to/private-key.pem
```

Inline PEM works too (use `\\n` for newlines):

```bash
npm run generate-public-key -- "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
```

## Simulation

Run the local simulation script:

```bash
npm run simulation
```

It executes `scripts/simulation.js`, which exercises the Hub locally for development and testing.

If you want to launch a full network of Oracles in simulation mode, use the Oracles repository:
https://github.com/avicenne-studio/qs-bridge-oracle


## Development

### Run the Hub in development mode

Run:
```bash
docker compose up --build
```

Access the API at:

```
http://localhost:3000
```

The SQLite database is stored in the `hub-sqlite` Docker volume at `/data/hub.sqlite3`.
Any changes to local `.ts` files reload automatically inside the container.

## Production

Use the production-optimized multi-stage image with the dedicated compose file:

```bash
docker compose -f docker-compose.prod.yml up --build -d
```

Stop the production service:

```bash
docker compose -f docker-compose.prod.yml down
```

## Node.js without Docker

Install dependencies:

```bash
npm install
```

Then run the script that pre-built for better-sqlite3:
```bash
npx allow-scripts run
```

> More info about `allow-scripts`: https://lavamoat.github.io/guides/allow-scripts/

This project uses better-sqlite3, which includes a native module that must be compiled during installation:

```bash
npm rebuild better-sqlite3 --ignore-scripts=false
```

Build TypeScript sources:

```bash
npm run build
```

Run with hot reload:

```bash
npm run dev
```

Run the production server:

```bash
npm start
```

## Testing and Coverage

Run the full test suite:

```bash
npm run test
```

> The codebase must maintain 100% statement/branch/function coverage—add or update tests alongside every change to keep the threshold intact.

## Linting

Check lint rules:

```bash
npm run lint
```

Autofix:

```bash
npm run lint:fix
```

## Contributing

See `CONTRIBUTING.md` for development workflow, testing expectations, and PR guidelines.

## Security

Please report security issues via `SECURITY.md`.

## License

Licensed under the terms in `LICENSE`.
