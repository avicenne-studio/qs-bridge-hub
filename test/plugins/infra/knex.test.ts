import { test, TestContext } from "node:test";
import fastify from "fastify";
import fp from "fastify-plugin";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import knex from "knex";
import knexPlugin, { kKnex } from "../../../src/plugins/infra/knex.js";
import { kConfig, type AppConfig } from "../../../src/plugins/infra/env.js";
import { ORDERS_TABLE_NAME } from "../../../src/plugins/app/indexer/orders.repository.js";

test("knex adds origin_trx_hash when orders table exists", async (t: TestContext) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-knex-"));
  const dbFile = path.join(dir, "hub.sqlite");
  const db = knex({
    client: "better-sqlite3",
    connection: { filename: dbFile },
    useNullAsDefault: true,
  });

  await db.schema.createTable(ORDERS_TABLE_NAME, (table) => {
    table.string("id").primary().notNullable();
    table.string("source").notNullable();
    table.string("dest").notNullable();
    table.string("from").notNullable();
    table.string("to").notNullable();
    table.string("amount").notNullable();
    table.string("relayerFee").notNullable().defaultTo("0");
    table.string("source_nonce").nullable();
    table.text("source_payload").nullable();
    table.boolean("oracle_accept_to_relay").notNullable().defaultTo(false);
    table.string("status").notNullable().defaultTo("in-progress");
  });
  await db.destroy();

  const app = fastify();
  const config: AppConfig = {
    PORT: 0,
    HOST: "127.0.0.1",
    RATE_LIMIT_MAX: 1,
    POLLER_INTERVAL_MS: 1000,
    SQLITE_DB_FILE: dbFile,
    ORACLE_URLS: "http://127.0.0.1:6101",
    ORACLE_SIGNATURE_THRESHOLD: 0.6,
    ORACLE_COUNT: 1,
    HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
    SOLANA_WS_URL: "ws://localhost:8900",
    SOLANA_FALLBACK_WS_URL: "ws://localhost:8901",
    SOLANA_LISTENER_ENABLED: false,
  };

  app.register(
    fp(async (instance) => {
      instance.decorate(kConfig, config);
    }, { name: "env" })
  );
  app.register(knexPlugin, {
    client: "better-sqlite3",
    connection: { filename: dbFile },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true,
  });

  await app.ready();

  t.after(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const accessor = app.getDecorator(kKnex);
  const hasOriginHash = await accessor
    .get()
    .schema.hasColumn(ORDERS_TABLE_NAME, "origin_trx_hash");
  t.assert.ok(hasOriginHash);
});
