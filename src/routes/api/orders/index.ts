import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  OracleChain,
  OracleOrderSchema,
} from "../../../plugins/app/indexer/schemas/order.js";
import { IdSchema, StringSchema } from "../../../plugins/app/common/schemas/common.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../plugins/app/indexer/orders.repository.js";
import { AppConfig, kConfig } from "../../../plugins/infra/env.js";
import { StoredEventSchema } from "../../../plugins/app/events/schemas/event.js";
import { EventsRepository, kEventsRepository } from "../../../plugins/app/events/events.repository.js";
import { computeRequiredSignatures } from "../../../plugins/app/oracle-service.js";

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
  Type.Object({ id: IdSchema }),
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
  orderId: IdSchema,
  signatures: Type.Array(SignatureSchema, { minItems: 1 }),
});

const RelayableSignaturesSchema = Type.Object({
  data: Type.Array(RelayableSignatureSchema),
});

const EventsQueryParamsSchema = Type.Object({
  after: Type.Integer({ minimum: 0, default: 0 }),
  limit: Type.Integer({ minimum: 1, maximum: 100, default: 50 }),
});

const EventsResponseSchema = Type.Object({
  data: Type.Array(StoredEventSchema),
  cursor: Type.Integer({ minimum: 0 }),
});

const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const ordersRepository =
    fastify.getDecorator<OrdersRepository>(kOrdersRepository);
  const config = fastify.getDecorator<AppConfig>(kConfig);
  const eventsRepository =
    fastify.getDecorator<EventsRepository>(kEventsRepository);
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
      const threshold = computeRequiredSignatures(
        config.ORACLE_SIGNATURE_THRESHOLD,
        config.ORACLE_COUNT
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

  fastify.get(
    "/events",
    {
      schema: {
        querystring: EventsQueryParamsSchema,
        response: {
          200: EventsResponseSchema,
        },
      },
    },
    async function handler(request) {
      const { after, limit } = request.query;
      try {
        const events = await eventsRepository.listAfter(after, limit);
        const cursor = events.length > 0 ? events[events.length - 1].id : after;
        return { data: events, cursor };
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to list events");
        throw fastify.httpErrors.internalServerError("Failed to list events");
      }
    }
  );
};

export default plugin;
