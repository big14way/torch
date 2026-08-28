import { createPublicClient, http, type Address } from "viem";
import { FSA, isXrplAddress } from "./config";

/** "Your XRP wallet already controls an address on Flare."
 *
 * Flare Smart Accounts derive a PersonalAccount from an XRPL address with
 * CREATE2, so the address exists as a fact about the r-address before anyone
 * funds it, signs anything, or connects a wallet. That makes it the one thing
 * this page can give a visitor for free, up front, before asking for anything.
 *
 * Verified on 2026-08-25: the controller is deployed at the same address on
 * Flare mainnet and Coston2, and both return the SAME PersonalAccount for the
 * same r-address. So this reads mainnet and the answer is chain-independent.
 */

const client = createPublicClient({ transport: http(FSA.rpc) });

const abi = [
  {
    type: "function",
    name: "getPersonalAccount",
    stateMutability: "view",
    inputs: [{ name: "_xrplOwner", type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const cache = new Map<string, Address>();

export async function flareAddressFor(rAddress: string): Promise<Address> {
  const r = rAddress.trim();
  if (!isXrplAddress(r)) throw new Error("That does not look like an XRP address. They start with r.");
  const hit = cache.get(r);
  if (hit) return hit;
  const addr = (await client.readContract({
    address: FSA.controller as Address,
    abi,
    functionName: "getPersonalAccount",
    args: [r],
  })) as Address;
  cache.set(r, addr);
  return addr;
}
