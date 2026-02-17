import {
  FastifyPluginAsyncTypebox,
  Type,
} from "@fastify/type-provider-typebox";
import {
  OracleOrderSchema,
  OracleOrderStatus,
} from "../../../plugins/app/indexer/schemas/order.js";
import {
  IdSchema,
} from "../../../plugins/app/common/schemas/common.js";
import {
  kOrdersRepository,
  type OrdersRepository,
} from "../../../plugins/app/indexer/orders.repository.js";
import { AppConfig, kConfig } from "../../../plugins/infra/env.js";
import { StoredEventSchema } from "../../../plugins/app/events/schemas/event.js";
import { EventsRepository, kEventsRepository } from "../../../plugins/app/events/events.repository.js";
import { computeRequiredSignatures } from "../../../plugins/app/oracle-service.js";
import {
  kFeeEstimation,
  type FeeEstimation,
} from "../../../plugins/app/fee-estimation/fee-estimation.js";
import {
  EstimationBodySchema,
  EstimationResponseSchema,
} from "../../../plugins/app/fee-estimation/schemas/estimation.js";

const OrdersQueryParamsSchema = Type.Object({
  page: Type.Integer({
    minimum: 1,
    default: 1,
    description: "Page number (1-based).",
    examples: [1],
  }),
  limit: Type.Integer({
    minimum: 1,
    maximum: 100,
    default: 10,
    description: "Number of orders per page (max 100).",
    examples: [10],
  }),
  order: Type.Union(
    [Type.Literal("asc"), Type.Literal("desc")],
    {
      default: "desc",
      description: "Sort order for `created_at`.",
      examples: ["desc"],
    }
  ),
  source: Type.Optional(
    Type.Union([Type.Literal("qubic"), Type.Literal("solana")], {
      description: "Filter by source chain.",
      examples: ["qubic"],
    })
  ),
  dest: Type.Optional(
    Type.Union([Type.Literal("qubic"), Type.Literal("solana")], {
      description: "Filter by destination chain.",
      examples: ["solana"],
    })
  ),
  status: Type.Optional(
    Type.Array(OracleOrderStatus, {
      description: "Filter by one or more order statuses.",
      examples: [["ready-for-relay", "finalized"]],
    })
  ),
  from: Type.Optional(
    Type.String({
      description: "Filter by sender address.",
      examples: ["QUBIC_SENDER_ADDR"],
    })
  ),
  to: Type.Optional(
    Type.String({
      description: "Filter by recipient address.",
      examples: ["SOLANA_RECIPIENT_ADDR"],
    })
  ),
  amount_min: Type.Optional(
    Type.String({
      pattern: "^[0-9]+$",
      description: "Minimum amount (integer string).",
      examples: ["1000"],
    })
  ),
  amount_max: Type.Optional(
    Type.String({
      pattern: "^[0-9]+$",
      description: "Maximum amount (integer string).",
      examples: ["500000"],
    })
  ),
  created_after: Type.Optional(
    Type.String({
      description: "ISO-8601 lower bound on created_at.",
      examples: ["2024-01-01T00:00:00.000Z"],
    })
  ),
  created_before: Type.Optional(
    Type.String({
      description: "ISO-8601 upper bound on created_at.",
      examples: ["2024-01-31T23:59:59.999Z"],
    })
  ),
  id: Type.Optional(
    Type.String({
      description: "Filter by order id.",
      examples: ["7b1d6f2c-7b4f-4bb8-8c53-0c1e87a1b2b1"],
    })
  ),
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

const OrderByTrxHashQuerySchema = Type.Object({
  hash: Type.String({
    description: "Origin transaction hash to lookup.",
    examples: ["0xabc123"],
  }),
});

const OrderByTrxHashResponseSchema = Type.Object({
  data: StoredOrderSchema,
});

const SignatureSchema = Type.String({
  description: "Oracle signature payload (string-encoded).",
  examples: ["0xdeadbeef"],
});

const RelayableSignatureSchema = Type.Object({
  orderId: IdSchema,
  signatures: Type.Array(SignatureSchema, { minItems: 1 }),
});

const RelayableSignaturesSchema = Type.Object({
  data: Type.Array(RelayableSignatureSchema),
});

const EventsQueryParamsSchema = Type.Object({
  created_after: Type.String({
    description:
      "Cursor lower bound for event creation time (ISO-8601). Required for the first page.",
    examples: ["2024-01-01T00:00:00.000Z"],
  }),
  after_id: Type.Integer({
    minimum: 0,
    default: 0,
    description:
      "Cursor id for pagination. Use the `cursor.id` from the previous response.",
    examples: [0],
  }),
  limit: Type.Integer({
    minimum: 1,
    maximum: 100,
    default: 50,
    description: "Maximum number of events to return (max 100).",
    examples: [50],
  }),
});

const EventsCursorSchema = Type.Object({
  createdAt: Type.String({
    description: "Cursor ISO-8601 timestamp.",
    examples: ["2024-01-01T00:00:00.000Z"],
  }),
  id: Type.Integer({ minimum: 0 }),
});

const EventsResponseSchema = Type.Object({
  data: Type.Array(StoredEventSchema),
  cursor: EventsCursorSchema,
});


const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  const ordersRepository =
    fastify.getDecorator<OrdersRepository>(kOrdersRepository);
  const config = fastify.getDecorator<AppConfig>(kConfig);
  const eventsRepository =
    fastify.getDecorator<EventsRepository>(kEventsRepository);
  const feeEstimation =
    fastify.getDecorator<FeeEstimation>(kFeeEstimation);
  fastify.get(
    "/",
    {
      schema: {
        querystring: OrdersQueryParamsSchema,
        summary: "List orders",
        description:
          "Returns paginated orders with optional filters (chain, status, amount range, time range).",
        tags: ["Orders"],
        response: {
          200: OrdersResponseSchema,
        },
      },
    },
    async function handler(request) {
      const {
        page,
        limit,
        order,
        source,
        dest,
        status,
        from,
        to,
        amount_min,
        amount_max,
        created_after,
        created_before,
        id,
      } = request.query;

      try {
        const result = await ordersRepository.paginate({
          page,
          limit,
          order,
          source,
          dest,
          status,
          from,
          to,
          amount_min,
          amount_max,
          created_after,
          created_before,
          id,
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
        summary: "List relayable order signatures",
        description:
          "Returns orders that have reached the required oracle signature threshold along with their signatures.",
        tags: ["Orders"],
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
        summary: "List bridge events",
        description:
          "Cursor-based pagination over stored events. Use the returned cursor to request the next page.",
        tags: ["Orders"],
        response: {
          200: EventsResponseSchema,
        },
      },
    },
    async function handler(request) {
      const { created_after, after_id, limit } = request.query;
      try {
        const events = await eventsRepository.listAfterCreatedAt(
          created_after,
          after_id,
          limit
        );
        const last = events.length > 0 ? events[events.length - 1] : null;
        const cursor = last
          ? { createdAt: last.createdAt, id: last.id }
          : { createdAt: created_after, id: after_id };
        return { data: events, cursor };
      } catch (error) {
        fastify.log.error({ err: error }, "Failed to list events");
        throw fastify.httpErrors.internalServerError("Failed to list events");
      }
    }
  );

  fastify.get(
    "/trx-hash",
    {
      schema: {
        querystring: OrderByTrxHashQuerySchema,
        summary: "Fetch order by origin transaction hash",
        description:
          "Returns the order that originated from the provided transaction hash.",
        tags: ["Orders"],
        response: {
          200: OrderByTrxHashResponseSchema,
        },
      },
    },
    async function handler(request) {
      const { hash } = request.query;
      const order = await ordersRepository.findByOriginTrxHash(hash);
        if (!order) {
          throw fastify.httpErrors.notFound("Order not found");
        }

        return { data: order };
    }
  );

  fastify.post(
    "/estimate",
    {
      schema: {
        body: EstimationBodySchema,
        summary: "Estimate bridge fees",
        description:
          "Returns a fee estimation for the provided amount and destination.",
        tags: ["Orders"],
        response: {
          200: EstimationResponseSchema,
        },
      },
    },
    async function handler(request) {
      const result = await feeEstimation.estimate(request.body);
      return { data: result };
    }
  );
};

export default plugin;
