import { type Static, Type } from "@sinclair/typebox";
import {
  AmountSchema,
  NetworkIdSchema,
} from "../../common/schemas/common.js";
import { SolanaAddressSchema } from "../../indexer/schemas/solana-transaction.js";
import { QubicAddressSchema } from "../../indexer/schemas/qubic-transaction.js";

const BridgeAddressSchema = Type.Union([
  SolanaAddressSchema,
  QubicAddressSchema,
]);

export const EstimationBodySchema = Type.Object({
  networkIn: NetworkIdSchema,
  networkOut: NetworkIdSchema,
  fromAddress: BridgeAddressSchema,
  toAddress: BridgeAddressSchema,
  amount: AmountSchema,
});

export type EstimationInput = Static<typeof EstimationBodySchema>;

const BridgeFeeSchema = Type.Object({
  oracleFee: AmountSchema,
  protocolFee: AmountSchema,
  total: AmountSchema,
});

export const EstimationOutputSchema = Type.Object({
  bridgeFee: BridgeFeeSchema,
  relayerFee: AmountSchema,
  networkFee: AmountSchema,
  userReceives: AmountSchema,
});

export type EstimationOutput = Static<typeof EstimationOutputSchema>;

export const EstimationResponseSchema = Type.Object({
  data: EstimationOutputSchema,
});

export interface ChainCostsEstimation {
  estimateUserNetworkFee(input?: EstimationInput): Promise<bigint>;
}
