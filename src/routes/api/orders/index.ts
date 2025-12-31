import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  OracleChain,
  OracleOrderSchema,
} from "../../../plugins/app/indexer/schemas/order.js";

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

const OrderSignatureSchema = Type.Object({
  id: Type.Integer({ minimum: 1 }),
  order_id: Type.Integer({ minimum: 1 }),
  signature: Type.String(),
});

const OrderWithSignaturesSchema = Type.Intersect([
  StoredOrderSchema,
  Type.Object({
    signatures: Type.Array(OrderSignatureSchema),
  }),
]);

const OrderSignaturesResponseSchema = Type.Object({
  data: Type.Array(OrderWithSignaturesSchema),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
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
        const result = await fastify.ordersRepository.paginate({
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
          200: OrderSignaturesResponseSchema,
        },
      },
    },
    async function handler() {
      const ids = await fastify.ordersRepository.findActivesIds();
      const orders = await fastify.ordersRepository.findByIdsWithSignatures(ids);

      return {
        data: orders.filter((order) => order.signatures.length > 0),
      };
    }
  );
};

export default plugin;
