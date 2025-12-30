import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";
import process from "node:process";

const ROOT_DIR = resolve(import.meta.dirname, "..");
const tmpRoot = join(os.tmpdir(), "hub-sim");
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

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
