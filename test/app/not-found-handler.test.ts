import { it, TestContext } from "node:test";
import { build } from "../helpers/build.js";

it("should call notFoundHandler", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    method: "GET",
    url: "/this-route-does-not-exist",
  });

  t.assert.strictEqual(res.statusCode, 404);
  t.assert.deepStrictEqual(JSON.parse(res.payload), {
    message: "Not Found",
  });
});

it("should be rate limited", async (t: TestContext) => {
  const app = await build(t);

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: "GET",
      url: "/this-route-does-not-exist",
    });

    t.assert.strictEqual(res.statusCode, 404, `Iteration ${i}`);
  }

  const res = await app.inject({
    method: "GET",
    url: "/this-route-does-not-exist",
  });

  t.assert.strictEqual(res.statusCode, 429, "Expected 429");
});
