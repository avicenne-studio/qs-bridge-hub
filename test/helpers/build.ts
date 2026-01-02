import fastify, { LightMyRequestResponse } from "fastify";
import { TestContext } from "node:test";
import serviceApp from "../../src/app.js";
import fp from "fastify-plugin";

// Fill in this config with all the configurations
// needed for testing the application
export function config() {
  return {
    skipOverride: true, // Register our application with fastify-plugin
  };
}

export function expectValidationError(
  t: TestContext,
  res: LightMyRequestResponse,
  expectedMessage: string
) {
  t.assert.strictEqual(res.statusCode, 400);
  const { message } = JSON.parse(res.payload);
  t.assert.strictEqual(message, expectedMessage);
}

// automatically build and tear down our instance
export async function build(t?: TestContext) {
  // you can set all the options supported by the fastify CLI command
  const app = fastify();
  app.register(fp(serviceApp));

  await app.ready()

  // This is after start, so we can't decorate the instance using `.decorate`

  // If we pass the test contest, it will close the app after we are done
  if (t) {
    t.after(() => app.close());
  }

  return app;
}

