import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Type, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { AppConfig, kConfig } from "./env.js";

const HubKeySchema = Type.Object({
  kid: Type.String({ minLength: 1 }),
  publicKeyPem: Type.String({ minLength: 1 }),
  privateKeyPem: Type.Optional(Type.String({ minLength: 1 })),
});

const HubKeyCurrentSchema = Type.Object({
  kid: Type.String({ minLength: 1 }),
  publicKeyPem: Type.String({ minLength: 1 }),
  privateKeyPem: Type.String({ minLength: 1 }),
});

export const HubKeysSchema = Type.Object({
  hubId: Type.String({ minLength: 1 }),
  current: HubKeyCurrentSchema,
  next: Type.Optional(HubKeySchema),
});

export type HubKeys = Static<typeof HubKeysSchema>;
export type HubPublicKey = {
  kid: string;
  publicKeyPem: string;
  fingerprint: string;
};
export type HubPublicKeys = {
  hubId: string;
  current: HubPublicKey;
  next?: HubPublicKey;
};

export const kHubKeys = Symbol("infra.hubKeys");
export const kHubPublicKeys = Symbol("infra.hubPublicKeys");

function resolveKeysPath(filePath: string) {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

export function fingerprintPublicKey(publicKeyPem: string) {
  return createHash("sha256").update(publicKeyPem).digest("hex");
}

export function toPublicKeys(keys: HubKeys): HubPublicKeys {
  const current = {
    kid: keys.current.kid,
    publicKeyPem: keys.current.publicKeyPem,
    fingerprint: fingerprintPublicKey(keys.current.publicKeyPem),
  };

  const next = keys.next
    ? {
        kid: keys.next.kid,
        publicKeyPem: keys.next.publicKeyPem,
        fingerprint: fingerprintPublicKey(keys.next.publicKeyPem),
      }
    : undefined;

  return {
    hubId: keys.hubId,
    current,
    ...(next ? { next } : {}),
  };
}

export async function readHubKeysFromFile(
  filePath: string
): Promise<HubKeys> {
  const prefix = "HUB_KEYS_FILE";
  const resolvedPath = resolveKeysPath(filePath);
  let raw: string;

  try {
    raw = await readFile(resolvedPath, "utf-8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(`${prefix}: file not found at ${resolvedPath}`);
    }
    throw new Error(`${prefix}: unable to read file - ${err.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${prefix}: file does not contain valid JSON`);
  }

  if (!Value.Check(HubKeysSchema, parsed)) {
    let errorMessage = "Invalid keys structure";
    for (const error of Value.Errors(HubKeysSchema, parsed)) {
      errorMessage = `${error.message} at ${error.path}`;
      break;
    }
    throw new Error(`${prefix}: invalid schema - ${errorMessage}`);
  }

  return parsed;
}

export default fp(
  async function hubKeysPlugin(fastify: FastifyInstance) {
    const config = fastify.getDecorator<AppConfig>(kConfig);
    const keys = await readHubKeysFromFile(config.HUB_KEYS_FILE);
    fastify.decorate(kHubKeys, keys);
    fastify.decorate(kHubPublicKeys, toPublicKeys(keys));
  },
  {
    name: "hub-keys",
    dependencies: ["env"],
  }
);
