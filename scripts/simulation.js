import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import process from "node:process";
import dotenv from "dotenv";

const ROOT_DIR = resolve(import.meta.dirname, "..");
dotenv.config({ path: join(ROOT_DIR, ".env.local") });
dotenv.config({ path: join(ROOT_DIR, ".env") });
const tmpRoot = join(os.tmpdir(), "hub-sim");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

const DEFAULT_ORACLE_URLS =
  "http://127.0.0.1:3001,http://127.0.0.1:3002,http://127.0.0.1:3003,http://127.0.0.1:3004,http://127.0.0.1:3005";

const FIXTURE_KEYS_FILE = resolve(
  ROOT_DIR,
  "test",
  "fixtures",
  "hub-keys.json"
);
const DEFAULT_SOLANA_WS_URL = "wss://api.devnet.solana.com";
const DEFAULT_SOLANA_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_TOKEN_MINT = "So1111111111111111111111111111111111111111";

const hubs = [
  { id: "hub-1", port: 3010, role: "primary", up: true },
  { id: "hub-2", port: 3011, role: "fallback", up: true },
];

const children = [];

function startHub(hub) {
  const dbFile = join(tmpRoot, `${hub.id}.sqlite3`);
  const child = spawn("npm", ["run", "dev"], {
    cwd: ROOT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(hub.port),
      SQLITE_DB_FILE: dbFile,
      ORACLE_URLS: DEFAULT_ORACLE_URLS,
      HUB_KEYS_FILE: FIXTURE_KEYS_FILE,
      SOLANA_WS_URL: process.env.SOLANA_WS_URL ?? DEFAULT_SOLANA_WS_URL,
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL ?? DEFAULT_SOLANA_RPC_URL,
      TOKEN_MINT: process.env.TOKEN_MINT ?? DEFAULT_TOKEN_MINT,
      SOLANA_LISTENER_ENABLED: "true",
    },
  });

  const prefix = `[${hub.id}:${hub.port}] `;
  child.stdout.on("data", (chunk) =>
    process.stdout.write(prefix + chunk.toString())
  );
  child.stderr.on("data", (chunk) =>
    process.stderr.write(prefix + chunk.toString())
  );

  children.push(child);
}

for (const hub of hubs) {
  if (hub.up) {
    startHub(hub);
  } else {
    process.stderr.write(`[${hub.id}:${hub.port}] intentionally down\n`);
  }
}

function shutdown() {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  // eslint-disable-next-line no-undef
  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(0);
  }, 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
