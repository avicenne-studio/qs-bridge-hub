import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";

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
  fastify.get(
    "/",
    {
      schema: {
        response: {
          200: KeysResponseSchema,
        },
      },
    },
    async function handler() {
      return fastify.hubPublicKeys;
    }
  );
};

export default plugin;
