import { useSyncExternalStore } from "react";
import { createPublicClient, fallback, http, isAddress, type Address } from "viem";

/** Read-only "watch" accounts: an XRPL user's Flare Smart Account has no EVM
 * key to connect with (actions travel XRPL payment → FDC proof → Flare, in
 * minutes), but its margin and positions are plain vault state under a
 * deterministic address. Paste an r-address, derive the PersonalAccount via
 * the MasterAccountController, and view the account like any other. */

const CONTROLLER = "0x434936d47503353f06750Db1A444DBDC5F0AD37c" as const;
const STORAGE_KEY = "torch.watch.v1";

export type WatchState = { rAddress: string | null; address: Address } | null;

let state: WatchState = load();
const subs = new Set<() => void>();

function load(): WatchState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WatchState) : null;
  } catch {
    return null;
  }
}

function emit() {
  subs.forEach((fn) => fn());
}

export function useWatch(): WatchState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => null
  );
}

export function stopWatching() {
  state = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
  emit();
}

export function isXrplAddress(s: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s);
}

// Same endpoints as the wagmi config: enosys primary, public fallback.
const client = createPublicClient({
  transport: fallback([
    http("https://coston2.enosys.global/ext/C/rpc"),
    http("https://coston2-api.flare.network/ext/C/rpc"),
  ]),
});

/** Accepts an XRPL r-address (derives its Smart Account) or a raw 0x address. */
export async function watchAccount(input: string): Promise<Address> {
  const s = input.trim();
  let address: Address;
  let rAddress: string | null = null;

  if (isAddress(s)) {
    address = s;
  } else if (isXrplAddress(s)) {
    // getPersonalAccount returns the CREATE2 address even before first use,
    // so any valid r-address resolves — balances just read zero until funded.
    address = (await client.readContract({
      address: CONTROLLER,
      abi: [
        {
          type: "function",
          name: "getPersonalAccount",
          stateMutability: "view",
          inputs: [{ name: "_xrplOwner", type: "string" }],
          outputs: [{ type: "address" }],
        },
      ] as const,
      functionName: "getPersonalAccount",
      args: [s],
    })) as Address;
    rAddress = s;
  } else {
    throw new Error("Enter an XRPL address (starts with r) or an 0x address.");
  }

  state = { rAddress, address };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode */
  }
  emit();
  return address;
}
