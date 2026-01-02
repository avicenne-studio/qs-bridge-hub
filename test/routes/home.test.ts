import { test, TestContext } from "node:test";
import { build } from "../helpers/build.js";

test("GET /", async (t: TestContext) => {
  const app = await build(t);
  const res = await app.inject({
    url: "/",
  });

  t.assert.deepStrictEqual(JSON.parse(res.payload), {
    message: "Welcome to the Qubic-Solana bridge oracle!",
  });
});
