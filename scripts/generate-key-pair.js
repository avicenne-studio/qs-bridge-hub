import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

const payload = {
  publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
};

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
