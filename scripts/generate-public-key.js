import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

// eslint-disable-next-line no-undef
const [, , privateKeyArg] = process.argv;

if (!privateKeyArg) {
// eslint-disable-next-line no-undef
  process.stderr.write(
    "Usage: npm run generate-public-key -- <private-key-pem-or-path>\n"
  );
// eslint-disable-next-line no-undef
  process.exitCode = 1;
} else {
  const looksLikePem =
    privateKeyArg.includes("-----BEGIN") &&
    privateKeyArg.includes("PRIVATE KEY-----");

  const privateKeyPem = looksLikePem
    ? privateKeyArg.replace(/\\n/g, "\n")
    : readFileSync(privateKeyArg, "utf8");

  const publicKey = createPublicKey(privateKeyPem);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
// eslint-disable-next-line no-undef
  process.stdout.write(publicKeyPem);
}
