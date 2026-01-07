import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , privateKeyArg] = process.argv;

if (!privateKeyArg) {
  process.stderr.write(
    "Usage: npm run generate-public-key -- <private-key-pem-or-path>\n"
  );
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
  process.stdout.write(publicKeyPem);
}
