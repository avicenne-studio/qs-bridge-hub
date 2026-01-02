import { it, TestContext } from "node:test";
import { build } from "../helpers/build.js";

it("should correctly handle CORS preflight requests", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    method: "OPTIONS",
    url: "/",
    headers: {
      Origin: "http://example.com",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });

  t.assert.strictEqual(res.statusCode, 204);
  t.assert.strictEqual(
    res.headers["access-control-allow-methods"],
    "GET, POST, PUT, DELETE"
  );
});
