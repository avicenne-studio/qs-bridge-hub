import { describe, it, TestContext } from "node:test";

import {
  OracleOrder,
  assertValidOracleOrder,
  normalizeBridgeInstruction,
} from "../../../src/plugins/app/indexer/schemas/order.js";

describe("OracleOrder utilities", () => {
  it("should accept valid orders with different source and dest", (t: TestContext) => {
    const order: OracleOrder = {
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "10",
      relayerFee: "1",
      origin_trx_hash: "trx-hash",
      status: "in-progress",
    };

    t.assert.doesNotThrow(() => assertValidOracleOrder(order));
  });

  it("should reject orders where source === dest", (t: TestContext) => {
    const order: OracleOrder = {
      source: "qubic",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: "1",
      relayerFee: "1",
      origin_trx_hash: "trx-hash",
      status: "finalized",
    };

    t.assert.throws(
      () => assertValidOracleOrder(order),
      /source and dest must differ/
    );
  });

  it("normalizeBridgeInstruction should always throw", (t: TestContext) => {
    t.assert.throws(
      () => normalizeBridgeInstruction("foo"),
      /not implemented/
    );
  });
});
