import { test, TestContext } from "node:test";
import { createHash } from "node:crypto";
import { build } from "../../helpers/build.js";
import { HubKeys, kHubKeys } from "../../../src/plugins/infra/hub-keys.js";

test("GET /api/keys exposes public keys with fingerprints", async (t: TestContext) => {
  const app = await build(t);
  const hubKeys = app.getDecorator<HubKeys>(kHubKeys);

  const res = await app.inject({
    method: "GET",
    url: "/api/keys",
  });

  t.assert.strictEqual(res.statusCode, 200);

  const payload = res.json() as {
    hubId: string;
    current: { kid: string; publicKeyPem: string; fingerprint: string };
    next?: { kid: string; publicKeyPem: string; fingerprint: string };
  };

  t.assert.strictEqual(payload.hubId, hubKeys.hubId);
  t.assert.strictEqual(payload.current.kid, hubKeys.current.kid);
  t.assert.strictEqual(payload.current.publicKeyPem, hubKeys.current.publicKeyPem);

  const expected = createHash("sha256")
    .update(hubKeys.current.publicKeyPem)
    .digest("hex");
  t.assert.strictEqual(payload.current.fingerprint, expected);

  t.assert.ok(!("privateKeyPem" in payload.current));
  if (payload.next) {
    t.assert.ok(!("privateKeyPem" in payload.next));
  }
});
