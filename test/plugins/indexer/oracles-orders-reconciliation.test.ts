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
  source_nonce: "nonce-1",
  source_payload: "{\"v\":1}",
  oracle_accept_to_relay: false,
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

  it("throws when provided orders differ on non-reconcilable fields", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, amount: "11", status: "finalized" },
    ];

    t.assert.throws(() => reconciliator.reconcile(orders));
  });

  it("reconciles a majority destination address", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, to: "Dest-1", status: "finalized" },
      { ...baseOrder, to: "Dest-1", status: "finalized" },
      { ...baseOrder, to: "Dest-2", status: "finalized" },
    ];

    const result = reconciliator.reconcile(orders);
    t.assert.strictEqual(result.to, "Dest-1");
  });

  it("throws when destination consensus cannot be determined", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, to: "Dest-1", status: "finalized" },
      { ...baseOrder, to: "Dest-2", status: "finalized" },
    ];

    t.assert.throws(
      () => reconciliator.reconcile(orders),
      /Unable to compute a consensus destination/
    );
  });

  it("reconciles a majority relayer fee", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, relayerFee: "1", status: "finalized" },
      { ...baseOrder, relayerFee: "1", status: "finalized" },
      { ...baseOrder, relayerFee: "2", status: "finalized" },
    ];

    const result = reconciliator.reconcile(orders);
    t.assert.strictEqual(result.relayerFee, "1");
  });

  it("throws when relayer fee consensus cannot be determined", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, relayerFee: "1", status: "finalized" },
      { ...baseOrder, relayerFee: "2", status: "finalized" },
    ];

    t.assert.throws(
      () => reconciliator.reconcile(orders),
      /Unable to compute a consensus relayer fee/
    );
  });

  it("throws when relayable flags differ", async (t: TestContext) => {
    const app = await build(t);
    const reconciliator =
      app.getDecorator<OracleOrdersReconciliatiorService>(
        kOracleOrdersReconciliatior
      );

    const orders: OracleOrder[] = [
      { ...baseOrder, status: "finalized" },
      { ...baseOrder, oracle_accept_to_relay: true, status: "finalized" },
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
});
