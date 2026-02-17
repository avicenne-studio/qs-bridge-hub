import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  HubPublicKeys,
  kHubPublicKeys,
} from "../../../plugins/infra/hub-keys.js";

const PublicKeySchema = Type.Object({
  kid: Type.String(),
  publicKeyPem: Type.String(),
  fingerprint: Type.String(),
});

const KeysResponseSchema = Type.Object({
  hubId: Type.String(),
  current: PublicKeySchema,
  next: Type.Optional(PublicKeySchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const hubPublicKeys = fastify.getDecorator<HubPublicKeys>(kHubPublicKeys);

  fastify.get(
    "/",
    {
      schema: {
        summary: "Get Hub public keys",
        description:
          "Returns the Hub id with the current public key and optional next key to support key rotation. Oracles can fetch this endpoint to verify `X-Hub-*` signatures and pre-trust the next key before rotation.",
        tags: ["Keys"],
        response: {
          200: KeysResponseSchema,
        },
      },
    },
    async function handler() {
      return hubPublicKeys;
    }
  );
};

export default plugin;
