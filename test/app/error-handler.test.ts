import { it, TestContext } from "node:test";
import fastify from "fastify";
import fp from "fastify-plugin";
import serviceApp from "../../src/app.js";

it("should call errorHandler", async (t: TestContext) => {
  const app = fastify();
  await app.register(fp(serviceApp));

  app.get("/error", () => {
    throw new Error("Kaboom!");
  });

  await app.ready();

  t.after(() => app.close());

  const res = await app.inject({
    method: "GET",
    url: "/error",
  });

  t.assert.deepStrictEqual(JSON.parse(res.payload), {
    message: "Internal Server Error",
  });
});
