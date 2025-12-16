import { describe, it } from "node:test";
import assert from "node:assert";

import { build } from "../../helper.js";
import { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";

const baseOrder: Omit<OracleOrder, "status"> = {
  source: "solana",
  dest: "qubic",
  from: "A",
  to: "B",
  amount: 10,
};

describe("oracleOrdersReconciliatior plugin", () => {
  it("produces the majority status", async (t) => {
    const app = await build(t);

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, status: "in-progress" },
    ];

    const result =
      app.oracleOrdersReconciliatior.reconcile(orders);

    assert.strictEqual(result.status, "finalized");
    assert.strictEqual(result.amount, baseOrder.amount);
  });

  it("throws when provided orders differ", async (t) => {
    const app = await build(t);

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, to: "C", status: "finalized" },
    ];

    assert.throws(() =>
      app.oracleOrdersReconciliatior.reconcile(orders)
    );
  });

  it("throws when consensus cannot be determined", async (t) => {
    const app = await build(t);

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, status: "in-progress" },
    ];

    assert.throws(
      () => app.oracleOrdersReconciliatior.reconcile(orders),
      /Unable to compute a consensus status/
    );
  });

  it("throws when the list is empty", async (t) => {
    const app = await build(t);

    assert.throws(
      () => app.oracleOrdersReconciliatior.reconcile([]),
      /Cannot reconcile an empty orders list/
    );
  });
});
