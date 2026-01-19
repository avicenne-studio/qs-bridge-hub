import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { HubKeys, kHubKeys } from "./hub-keys.js";

export type SignRequestInput = {
  method: string;
  url: string;
  body?: string | Buffer | Uint8Array;
};

export type SignedHeaders = {
  "X-Hub-Id": string;
  "X-Key-Id": string;
  "X-Timestamp": string;
  "X-Nonce": string;
  "X-Body-Hash": string;
  "X-Signature": string;
};

export type HubSignerService = {
  signHeaders(input: SignRequestInput): SignedHeaders;
};

export const kHubSigner = Symbol("infra.hubSigner");

export function hashBody(body?: string | Buffer | Uint8Array): string {
  if (!body) {
    return createHash("sha256").update("").digest("hex");
  }

  const payload = Buffer.from(body);

  return createHash("sha256").update(payload).digest("hex");
}

export function buildCanonicalString(input: {
  method: string;
  url: string;
  hubId: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
}): string {
  return (
    [
      input.method.toUpperCase(),
      input.url,
      `hubId=${input.hubId}`,
      `timestamp=${input.timestamp}`,
      `nonce=${input.nonce}`,
      `bodyhash=${input.bodyHash}`,
    ].join("\n") + "\n"
  );
}

export default fp(
  async function hubSignerPlugin(fastify: FastifyInstance) {
    const keys = fastify.getDecorator<HubKeys>(kHubKeys);
    const key = createPrivateKey(keys.current.privateKeyPem);

    fastify.decorate(kHubSigner, {
      signHeaders(input: SignRequestInput): SignedHeaders {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = randomBytes(16).toString("base64");
        const bodyHash = hashBody(input.body);
        const canonical = buildCanonicalString({
          method: input.method,
          url: input.url,
          hubId: keys.hubId,
          timestamp,
          nonce,
          bodyHash,
        });
        const signature = sign(null, Buffer.from(canonical), key).toString(
          "base64"
        );

        return {
          "X-Hub-Id": keys.hubId,
          "X-Key-Id": keys.current.kid,
          "X-Timestamp": timestamp,
          "X-Nonce": nonce,
          "X-Body-Hash": bodyHash,
          "X-Signature": signature,
        };
      },
    });
  },
  {
    name: "hub-signer",
    dependencies: ["hub-keys"],
  }
);
