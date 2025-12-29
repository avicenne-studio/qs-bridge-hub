# Qubic Solana Bridge Hub

This repository hosts the Hub responsible for validating Solana <-> Qubic bridge transactions.

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
