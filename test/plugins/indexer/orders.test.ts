import { describe, it, TestContext } from "node:test";

import {
  OracleOrder,
  assertValidOracleOrder,
  orderFromQubic,
  orderFromSolana,
  normalizeBridgeInstruction,
} from "../../../src/plugins/app/indexer/schemas/order.js";
import { QubicTransaction } from "../../../src/plugins/app/indexer/schemas/qubic-transaction.js";
import { SolanaTransaction } from "../../../src/plugins/app/indexer/schemas/solana-transaction.js";

const mockQubicTx: QubicTransaction = {
  sender: "AliceQ",
  recipient: "BobQ",
  amount: 999,
  nonce: 1,
};

const mockSolanaTx: SolanaTransaction = {
  recentBlockhash: "ABC123",
  feePayer: "FEEPAYER111",
  instructions: [
    {
      programId: "PROGRAM1",
      accounts: [],
      data: "encoded-bridge-data",
    },
  ],
};

describe("OracleOrder utilities", () => {
  it("should accept valid orders with different source and dest", (t: TestContext) => {
    const order: OracleOrder = {
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 10,
      is_relayable: false,
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
      amount: 1,
      is_relayable: true,
      status: "finalized",
    };

    t.assert.throws(
      () => assertValidOracleOrder(order),
      /source and dest must differ/
    );
  });

  it("should construct an order from a Qubic transaction", (t: TestContext) => {
    const order = orderFromQubic(mockQubicTx, "solana");

    t.assert.strictEqual(order.source, "qubic");
    t.assert.strictEqual(order.dest, "solana");
    t.assert.strictEqual(order.from, mockQubicTx.sender);
    t.assert.strictEqual(order.to, mockQubicTx.recipient);
    t.assert.strictEqual(order.amount, mockQubicTx.amount);
    t.assert.strictEqual(order.is_relayable, false);
    t.assert.strictEqual(order.status, "in-progress");
  });

  it("should throw when Qubic order has identical source and dest", (t: TestContext) => {
    t.assert.throws(
      () => orderFromQubic(mockQubicTx, "qubic"),
      /source and dest must differ/
    );
  });

  it("should throw because normalizeBridgeInstruction is not implemented", (t: TestContext) => {
    t.assert.throws(
      () => orderFromSolana(mockSolanaTx, "qubic"),
      /not implemented/
    );
  });

  it("normalizeBridgeInstruction should always throw", (t: TestContext) => {
    t.assert.throws(
      () => normalizeBridgeInstruction("foo"),
      /not implemented/
    );
  });
});
