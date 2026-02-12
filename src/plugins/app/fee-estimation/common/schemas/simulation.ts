import { type Static, Type } from "@sinclair/typebox";
import {
  AmountSchema,
  BridgeAddressSchema,
  NetworkIdSchema,
} from "../../../common/schemas/common.js";

export const SimulationBodySchema = Type.Object({
  networkIn: NetworkIdSchema,
  networkOut: NetworkIdSchema,
  fromAddress: BridgeAddressSchema,
  toAddress: BridgeAddressSchema,
  amount: AmountSchema,
});

export type SimulationInput = Static<typeof SimulationBodySchema>;

const BridgeFeeSchema = Type.Object({
  oracleFee: AmountSchema,
  protocolFee: AmountSchema,
  total: AmountSchema,
});

export const SimulationOutputSchema = Type.Object({
  bridgeFee: BridgeFeeSchema,
  relayerFee: AmountSchema,
  networkFee: AmountSchema,
  userReceives: AmountSchema,
});

export type SimulationOutput = Static<typeof SimulationOutputSchema>;

export const SimulationResponseSchema = Type.Object({
  data: SimulationOutputSchema,
});

export interface ChainCostsEstimation {
  estimateUserNetworkFee(input?: SimulationInput): Promise<number>;
}
