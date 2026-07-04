import { useReadContract, useReadContracts } from "wagmi";
import { hexToString } from "viem";
import { VAULT, DEPLOY, type Position } from "./config";

export const fmtUsd6 = (x: bigint, digits = 2) =>
  (Number(x) / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const fmtFxrp = (x: bigint, digits = 2) =>
  (Number(x) / 1e6).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

export const fmtPx = (x: bigint) => {
  const n = Number(x) / 1e6;
  const digits = n >= 1000 ? 1 : n >= 10 ? 2 : 4;
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

export const marketName = (id: `0x${string}`) => hexToString(id, { size: 32 });

export function useMarkPrice(marketId: `0x${string}` | undefined) {
  return useReadContract({
    ...VAULT,
    functionName: "markPrice6",
    args: marketId ? [marketId] : undefined,
    query: { enabled: !!marketId, refetchInterval: 3000 },
  });
}

export function useXrpPrice() {
  const xrp = DEPLOY.markets.find((m) => m.key === "XRP");
  return useMarkPrice(xrp?.id);
}

export function usePositions(address: `0x${string}` | undefined) {
  return useReadContract({
    ...VAULT,
    functionName: "getUserPositions",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 3000 },
  }) as { data: Position[] | undefined; refetch: () => void };
}

export function useFreeMargin(address: `0x${string}` | undefined) {
  return useReadContract({
    ...VAULT,
    functionName: "freeMargin",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 3000 },
  }) as { data: bigint | undefined; refetch: () => void };
}

/** Live PnL of an open position in USD 6dp, from current mark. */
export function livePnlUsd6(p: Position, mark: bigint | undefined): bigint | null {
  if (!mark || p.entryPrice6 === 0n) return null;
  const size = p.sizeUsd6;
  const entry = p.entryPrice6;
  return p.isLong ? (size * (mark - entry)) / entry : (size * (entry - mark)) / entry;
}

/** Protocol-wide live numbers: insurance fund, open interest, notional routed. */
export function useGlobalStats() {
  const { data: count } = useReadContract({
    ...VAULT,
    functionName: "positionsCount",
    query: { refetchInterval: 10000 },
  });
  const { data: insurance } = useReadContract({
    ...VAULT,
    functionName: "insuranceFund",
    query: { refetchInterval: 10000 },
  });
  const n = count ? Number(count) : 0;
  const { data: results } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      ...VAULT,
      functionName: "getPosition",
      args: [BigInt(i)],
    })),
    query: { enabled: n > 0, refetchInterval: 10000 },
  });

  let openInterest = 0n;
  let volume = 0n;
  let openCount = 0;
  for (const r of results ?? []) {
    const p = r.result as Position | undefined;
    if (!p) continue;
    if (p.entryPrice6 > 0n) volume += p.sizeUsd6; // every position that ever filled
    if (Number(p.status) === 2) {
      openInterest += p.sizeUsd6;
      openCount += 1;
    }
  }

  return {
    insurance: (insurance as bigint | undefined) ?? 0n,
    positions: n,
    openInterest,
    volume,
    openCount,
  };
}
