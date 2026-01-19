import { test, TestContext } from "node:test";
import { createPublicKey, verify } from "node:crypto";
import { build } from "../../helpers/build.js";
import {
  buildCanonicalString,
  hashBody,
  HubSignerService,
  kHubSigner,
} from "../../../src/plugins/infra/hub-signer.js";
import { HubKeys, kHubKeys } from "../../../src/plugins/infra/hub-keys.js";

test("hub signer creates verifiable headers", async (t: TestContext) => {
  const app = await build(t);
  const hubSigner = app.getDecorator<HubSignerService>(kHubSigner);
  const hubKeys = app.getDecorator<HubKeys>(kHubKeys);

  const headers = hubSigner.signHeaders({
    method: "GET",
    url: "/api/health",
  });

  t.assert.strictEqual(headers["X-Hub-Id"], hubKeys.hubId);
  t.assert.strictEqual(headers["X-Key-Id"], hubKeys.current.kid);

  const canonical = buildCanonicalString({
    method: "GET",
    url: "/api/health",
    hubId: headers["X-Hub-Id"],
    timestamp: headers["X-Timestamp"],
    nonce: headers["X-Nonce"],
    bodyHash: headers["X-Body-Hash"],
  });

  const signature = Buffer.from(headers["X-Signature"], "base64");
  const publicKey = createPublicKey(hubKeys.current.publicKeyPem);

  const ok = verify(null, Buffer.from(canonical), publicKey, signature);
  t.assert.ok(ok, "signature should verify against public key");

  const payloadHash = hashBody("payload");
  t.assert.strictEqual(payloadHash.length, 64);

  const bufferHash = hashBody(Buffer.from("payload"));
  t.assert.strictEqual(bufferHash, payloadHash);
});
