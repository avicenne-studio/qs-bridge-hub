import { describe, it } from "node:test";
import assert from "node:assert";

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
  it("should accept valid orders with different source and dest", () => {
    const order: OracleOrder = {
      source: "solana",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 10,
    };

    assert.doesNotThrow(() => assertValidOracleOrder(order));
  });

  it("should reject orders where source === dest", () => {
    const order: OracleOrder = {
      source: "qubic",
      dest: "qubic",
      from: "A",
      to: "B",
      amount: 1,
    };

    assert.throws(
      () => assertValidOracleOrder(order),
      /source and dest must differ/
    );
  });

  it("should construct an order from a Qubic transaction", () => {
    const order = orderFromQubic(mockQubicTx, "solana");

    assert.strictEqual(order.source, "qubic");
    assert.strictEqual(order.dest, "solana");
    assert.strictEqual(order.from, mockQubicTx.sender);
    assert.strictEqual(order.to, mockQubicTx.recipient);
    assert.strictEqual(order.amount, mockQubicTx.amount);
  });

  it("should throw when Qubic order has identical source and dest", () => {
    assert.throws(
      () => orderFromQubic(mockQubicTx, "qubic"),
      /source and dest must differ/
    );
  });

  it("should throw because normalizeBridgeInstruction is not implemented", () => {
    assert.throws(
      () => orderFromSolana(mockSolanaTx, "qubic"),
      /not implemented/
    );
  });

  it("normalizeBridgeInstruction should always throw", () => {
    assert.throws(
      () => normalizeBridgeInstruction("foo"),
      /not implemented/
    );
  });
});
