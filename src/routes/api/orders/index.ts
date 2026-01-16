import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  OracleChain,
  OracleOrderSchema,
} from "../../../plugins/app/indexer/schemas/order.js";
import { StringSchema } from "../../../plugins/app/common/schemas/common.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../plugins/app/indexer/orders.repository.js";

const OrderDirectionSchema = Type.Union(
  [Type.Literal("asc"), Type.Literal("desc")],
  { default: "desc" }
);

const OrdersQueryParamsSchema = Type.Object({
  page: Type.Integer({ minimum: 1, default: 1 }),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  order: OrderDirectionSchema,
  source: Type.Optional(OracleChain),
  dest: Type.Optional(OracleChain),
});

const StoredOrderSchema = Type.Intersect([
  Type.Object({ id: Type.Integer({ minimum: 1 }) }),
  OracleOrderSchema,
]);

const OrdersResponseSchema = Type.Object({
  data: Type.Array(StoredOrderSchema),
  pagination: Type.Object({
    page: Type.Integer({ minimum: 1 }),
    limit: Type.Integer({ minimum: 1 }),
    total: Type.Integer({ minimum: 0 }),
  }),
});

const SignatureSchema = StringSchema;

const RelayableSignatureSchema = Type.Object({
  orderId: Type.Integer({ minimum: 1 }),
  signatures: Type.Array(SignatureSchema, { minItems: 1 }),
});

const RelayableSignaturesSchema = Type.Object({
  data: Type.Array(RelayableSignatureSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const ordersRepository =
    fastify.getDecorator<OrdersRepository>(kOrdersRepository);
  fastify.get(
    "/",
    {
      schema: {
        querystring: OrdersQueryParamsSchema,
        response: {
          200: OrdersResponseSchema,
        },
      },
    },
    async function handler(request) {
      const { page, limit, order, source, dest } = request.query;

      try {
        const result = await ordersRepository.paginate({
          page,
          limit,
          order,
          source,
          dest,
        });

        return {
          data: result.orders,
          pagination: {
            page,
            limit,
            total: result.total,
          },
        };
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to list orders");
        throw fastify.httpErrors.internalServerError("Failed to list orders");
      }
    }
  );

  fastify.get(
    "/signatures",
    {
      schema: {
        response: {
          200: RelayableSignaturesSchema,
        },
      },
    },
    async function handler() {
      const threshold = Math.max(
        1,
        Math.floor(fastify.config.ORACLE_SIGNATURE_THRESHOLD)
      );
      const ids = await ordersRepository.findRelayableIds();
      const orders = await ordersRepository.findByIdsWithSignatures(ids);

      return {
        data: orders
          .filter(
            (order) =>
              order.signatures.length >= threshold
          )
          .map((order) => ({
            orderId: order.id,
            signatures: order.signatures.map((signature) => signature.signature),
          })),
      };
    }
  );
};

export default plugin;
