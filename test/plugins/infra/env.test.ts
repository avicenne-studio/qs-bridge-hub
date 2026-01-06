import { test, TestContext } from "node:test";
import fastify from "fastify";
import fp from "fastify-plugin";
import envPlugin, { autoConfig } from "../../../src/plugins/infra/env.js";

test("rejects invalid ORACLE_URLS entries", async (t: TestContext) => {
  const app = fastify();

  app.register(fp(envPlugin), {
    ...autoConfig,
    dotenv: false,
    data: {
      PORT: 3000,
      RATE_LIMIT_MAX: 100,
      SQLITE_DB_FILE: ":memory:",
      ORACLE_URLS: "https://ok.example,ftp://bad.example",
      HUB_KEYS_FILE: "./test/fixtures/hub-keys.json",
    },
  });

  await t.assert.rejects(async () => app.ready(), /ORACLE_URLS/);
});
