import { it, TestContext } from "node:test";
import { build } from "../helper.js";

it("should be rate limited", async (t: TestContext) => {
  const app = await build(t);

  for (let i = 0; i < 4; i++) {
    const res = await app.inject({
      method: "GET",
      url: "/",
    });

    t.assert.strictEqual(res.statusCode, 200);
  }

  const res = await app.inject({
    method: "GET",
    url: "/",
  });

  t.assert.strictEqual(res.statusCode, 429);
});
