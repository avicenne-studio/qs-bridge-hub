import { test, TestContext } from "node:test";
import { build } from "../../helpers/build.js";
import {
  kEventsRepository,
  type EventsRepository,
} from "../../../src/plugins/app/events/events.repository.js";

const hex32 = (value: number) => value.toString(16).padStart(64, "0");

async function seedEvents(app: Awaited<ReturnType<typeof build>>) {
  const eventsRepository =
    app.getDecorator<EventsRepository>(kEventsRepository);
  await eventsRepository.create({
    signature: "sig-701",
    slot: 10,
    chain: "solana",
    type: "outbound",
    nonce: hex32(1),
    payload: {
      networkIn: 1,
      networkOut: 2,
      tokenIn: hex32(2),
      tokenOut: hex32(3),
      fromAddress: hex32(4),
      toAddress: hex32(5),
      amount: "10",
      relayerFee: "2",
      nonce: hex32(1),
    },
  });
  await eventsRepository.create({
    signature: "sig-702",
    slot: 11,
    chain: "solana",
    type: "override-outbound",
    nonce: hex32(2),
    payload: {
      toAddress: hex32(6),
      relayerFee: "3",
      nonce: hex32(2),
    },
  });
}

test("GET /api/orders/events returns event list and cursor", async (t: TestContext) => {
  const app = await build(t);
  await seedEvents(app);

  const res = await app.inject({
    url: "/api/orders/events?after=0&limit=10",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);

  t.assert.strictEqual(body.data.length, 2);
  t.assert.strictEqual(body.data[0].signature, "sig-701");
  t.assert.strictEqual(body.cursor, body.data[1].id);
});

test("GET /api/orders/events returns empty cursor when no events", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    url: "/api/orders/events?after=0&limit=10",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  t.assert.deepStrictEqual(body.data, []);
  t.assert.strictEqual(body.cursor, 0);
});

test("GET /api/orders/events handles repository errors", async (t: TestContext) => {
  const app = await build(t);
  const eventsRepository =
    app.getDecorator<EventsRepository>(kEventsRepository);
  const { mock: repoMock } = t.mock.method(eventsRepository, "listAfter");
  repoMock.mockImplementation(() => {
    throw new Error("db down");
  });
  const { mock: logMock } = t.mock.method(app.log, "error");

  const res = await app.inject({
    url: "/api/orders/events",
    method: "GET",
  });

  t.assert.strictEqual(res.statusCode, 500);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logPayload, logMsg] = logMock.calls[0].arguments as any;
  t.assert.strictEqual(logMsg, "Failed to list events");
  t.assert.strictEqual(logPayload.err.message, "db down");

  const body = JSON.parse(res.payload);
  t.assert.strictEqual(body.message, "Internal Server Error");
});
