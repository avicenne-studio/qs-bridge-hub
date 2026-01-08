import { describe, test, TestContext } from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  fingerprintPublicKey,
  readHubKeysFromFile,
  toPublicKeys,
} from "../../../src/plugins/infra/hub-keys.js";

const fixturesDir = path.join(process.cwd(), "test", "fixtures");

describe("hub keys loader", () => {
  test("reads valid keys file", async (t: TestContext) => {
    const keys = await readHubKeysFromFile(
      path.join(fixturesDir, "hub-keys.json")
    );

    t.assert.strictEqual(keys.hubId, "primary");
    t.assert.strictEqual(keys.current.kid, "current-1");
    t.assert.ok(keys.current.privateKeyPem.length > 0);
  });

  test("rejects missing file", async (t: TestContext) => {
    await t.assert.rejects(
      () => readHubKeysFromFile(path.join(fixturesDir, "missing.json")),
      /file not found/
    );
  });

  test("rejects unreadable file errors", async (t: TestContext) => {
    await t.assert.rejects(
      () => readHubKeysFromFile(fixturesDir),
      /unable to read file/
    );
  });

  test("rejects invalid JSON payload", async (t: TestContext) => {
    await t.assert.rejects(
      () => readHubKeysFromFile(path.join(fixturesDir, "hub-keys-invalid-json.txt")),
      /does not contain valid JSON/
    );
  });

  test("rejects invalid schema", async (t: TestContext) => {
    await t.assert.rejects(
      () =>
        readHubKeysFromFile(path.join(fixturesDir, "hub-keys-invalid-schema.json")),
      /invalid schema/
    );
  });

  test("computes public key fingerprints", async (t: TestContext) => {
    const keys = await readHubKeysFromFile(
      path.join(fixturesDir, "hub-keys.json")
    );
    const publicKeys = toPublicKeys(keys);

    const expected = createHash("sha256")
      .update(keys.current.publicKeyPem)
      .digest("hex");

    t.assert.strictEqual(publicKeys.current.fingerprint, expected);
    t.assert.strictEqual(
      fingerprintPublicKey(keys.current.publicKeyPem),
      expected
    );
  });

  test("omits next key when missing", async (t: TestContext) => {
    const keys = await readHubKeysFromFile(
      path.join(fixturesDir, "hub-keys.json")
    );
    const withoutNext = { ...keys };
    delete (withoutNext as { next?: unknown }).next;

    const publicKeys = toPublicKeys(withoutNext);
    t.assert.ok(!("next" in publicKeys));
  });
});
