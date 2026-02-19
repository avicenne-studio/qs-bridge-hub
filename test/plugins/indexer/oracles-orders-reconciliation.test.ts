import { describe, it, TestContext } from "node:test";

import { build } from "../../helpers/build.js";
import { OracleOrder } from "../../../src/plugins/app/indexer/schemas/order.js";
import {
  kOracleOrdersReconciliatior,
  OracleOrdersReconciliatiorService,
} from "../../../src/plugins/app/indexer/oracle-orders-reconciliation.js";

const baseOrder: Omit<OracleOrder, "status"> = {
  source: "solana",
  dest: "qubic",
  from: "A",
  to: "B",
  amount: "10",
  relayerFee: "1",
  origin_trx_hash: "trx-hash",
  source_nonce: "nonce",
  source_payload: "{\"v\":1}",
};

describe("oracleOrdersReconciliatior plugin", () => {
  it("produces the majority status", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, status: "in-progress" },
    ];

    const result = reconciliator.reconcile(orders);

    t.assert.strictEqual(result.status, "finalized");
    t.assert.strictEqual(result.amount, baseOrder.amount);
  });

  it("throws when provided orders differ", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, to: "C", status: "finalized" },
    ];

    t.assert.throws(() => reconciliator.reconcile(orders));
  });

  it(
    "throws when consensus cannot be determined",
    async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, status: "in-progress" },
    ];

      t.assert.throws(
        () => reconciliator.reconcile(orders),
        /Unable to compute a consensus status/
      );
    }
  );

  it("throws when the list is empty", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    t.assert.throws(
      () => reconciliator.reconcile([]),
      /Cannot reconcile an empty orders list/
    );
  });

  it("picks consensus destination_trx_hash from majority", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized", destination_trx_hash: "hash-abc" },
      { ...baseOrder, status: "finalized", destination_trx_hash: "hash-abc" },
      { ...baseOrder, status: "finalized" },
    ];

    const result = reconciliator.reconcile(orders);

    t.assert.strictEqual(result.status, "finalized");
    t.assert.strictEqual(result.destination_trx_hash, "hash-abc");
  });

  it("returns no destination_trx_hash when no oracle has it", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "relayed" },
      { ...baseOrder, status: "relayed" },
      { ...baseOrder, status: "relayed" },
    ];

    const result = reconciliator.reconcile(orders);

    t.assert.strictEqual(result.status, "relayed");
    t.assert.strictEqual(result.destination_trx_hash, undefined);
  });
});
