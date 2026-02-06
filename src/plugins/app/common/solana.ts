import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";

export const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;

export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as Address;

export const BASE_FEE_LAMPORTS = 5_000;

export const ATA_RENT_LAMPORTS = 2_039_280;

export const INBOUND_ORDER_RENT_LAMPORTS = 1_155_360;

export const INBOUND_CU = 200_000;

export async function findAssociatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
): Promise<Address> {
  const encoder = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      encoder.encode(owner),
      encoder.encode(tokenProgram),
      encoder.encode(mint),
    ],
  });
  return ata;
}
