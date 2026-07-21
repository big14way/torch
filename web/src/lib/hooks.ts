import { useRef } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { keepPreviousData } from "@tanstack/react-query";
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

/** Every position in the vault. Stats and the leaderboard both derive from
 * this one query set; wagmi dedupes identical queries, so mounting both costs
 * no extra RPC calls. */
export function useAllPositions(): { positions: Position[]; loading: boolean } {
  const { data: count } = useReadContract({
    ...VAULT,
    functionName: "positionsCount",
    // keepPreviousData: hold the last value on screen during the 10s refetch
    // (and when the position count changes) so the dashboard never flashes to 0.
    query: { refetchInterval: 10000, placeholderData: keepPreviousData },
  });
  const n = count !== undefined ? Number(count) : 0;
  const { data: results } = useReadContracts({
    contracts: Array.from({ length: n }, (_, i) => ({
      ...VAULT,
      functionName: "getPosition",
      args: [BigInt(i)],
    })),
    // keep the prior batch visible while a longer/newer batch loads (a new
    // position changes the query key) so derived stats don't collapse to 0.
    query: { enabled: n > 0, refetchInterval: 10000, placeholderData: keepPreviousData },
  });
  // Merge fresh reads over the last good snapshot. Under public-RPC rate
  // limits, individual calls inside the batch can fail while the query itself
  // "succeeds" — a failed read must show the last-known position, never
  // subtract it from the stats (this was the dashboard flashing to 0).
  const cacheRef = useRef<Map<number, Position>>(new Map());
  const cache = cacheRef.current;
  (results ?? []).forEach((r, i) => {
    if (r.status === "success" && r.result) cache.set(i, r.result as Position);
  });
  const out: Position[] = [];
  for (let i = 0; i < n; i++) {
    const p = cache.get(i);
    if (p) out.push(p);
  }
  return { positions: out, loading: count === undefined || (n > 0 && out.length === 0) };
}

/** Protocol-wide live numbers: insurance fund, open interest, notional routed. */
export function useGlobalStats() {
  const { data: insurance } = useReadContract({
    ...VAULT,
    functionName: "insuranceFund",
    // keepPreviousData: hold the last value on screen during the 10s refetch
    // (and when the position count changes) so the dashboard never flashes to 0.
    query: { refetchInterval: 10000, placeholderData: keepPreviousData },
  });
  const { positions: all } = useAllPositions();

  let openInterest = 0n;
  let volume = 0n;
  let openCount = 0;
  for (const p of all) {
    if (p.entryPrice6 > 0n) volume += p.sizeUsd6; // every position that ever filled
    if (Number(p.status) === 2) {
      openInterest += p.sizeUsd6;
      openCount += 1;
    }
  }

  return {
    insurance: (insurance as bigint | undefined) ?? 0n,
    positions: all.length,
    openInterest,
    volume,
    openCount,
  };
}

// Paper Perps League window (unix seconds, UTC). 0 = all-time.
// Season 1: Jul 7 00:00 -> Jul 21 23:59:59 UTC (final board archived in the S1 wrap thread).
// Season 2: Wed Jul 22 2026 00:00 UTC -> Wed Aug 5 2026 23:59:59 UTC.
export const LEAGUE_SEASON = "Season 2";
export const LEAGUE_START = 1784678400;
export const LEAGUE_END = 1785974399;
export const LEAGUE_DATES = "Jul 22 – Aug 5, 2026";
export const LEAGUE_PRIZE = "$150 in FXRP · top 10 paid";

// House wallets stay ON the board during testnet — they're the founder's live
// smoke test for the leaderboard (if the board misbehaves and testers are quiet,
// trading from one of these shows the problem immediately). They are skipped at
// payout time, and get filtered from the board entirely at mainnet.
export const HOUSE_WALLETS = new Set(
  [
    "0x3C343AD077983371b29fee386bdBC8a92E934C51", // deploy executor / treasury
    "0x9F6c5F65f8dA4fAe06a9fB5096C6745194D45166", // enclave executor (current)
    "0x9c5B9F8DF63404bBb0B8Eaa51eF657daBEE4125c", // enclave executor (retired)
    "0x208B2660e5F62CDca21869b389c5aF9E7f0faE89", // founder demo wallet
  ].map((a) => a.toLowerCase())
);

export type LeagueRow = {
  owner: `0x${string}`;
  realizedFxrp: bigint;
  trades: number;
  volumeUsd6: bigint;
  liquidations: number;
  open: number;
};

/** Rank every trader by realized PnL (FXRP). Liquidations count against you.
 * Settled results belong to the season they SETTLE in (closedAt), so a
 * position opened before the window but liquidated inside it still counts;
 * open exposure is windowed by openedAt. Losses are capped at posted margin:
 * the contract stores unclamped mark PnL, but nobody can lose more than they
 * put up. */
export function useLeaderboard(): { rows: LeagueRow[]; loading: boolean; preSeason: boolean } {
  const { positions: all, loading } = useAllPositions();
  // Before the season opens, show all-time standings so the board is never empty
  // for testing, the announcement screenshot, or the how-to video. Once the
  // season starts, the window applies strictly.
  const now = Math.floor(Date.now() / 1000);
  const preSeason = LEAGUE_START > 0 && now < LEAGUE_START;
  const by = new Map<string, LeagueRow>();
  for (const p of all) {
    if (p.entryPrice6 === 0n) continue; // never filled
    const s = Number(p.status);
    const settled = s === 4 || s === 5;
    const t = Number(settled ? p.closedAt : p.openedAt);
    if (!preSeason) {
      if (LEAGUE_START && t < LEAGUE_START) continue;
      if (LEAGUE_END && t > LEAGUE_END) continue;
    }
    const row =
      by.get(p.owner) ??
      ({ owner: p.owner, realizedFxrp: 0n, trades: 0, volumeUsd6: 0n, liquidations: 0, open: 0 } as LeagueRow);
    row.trades += 1;
    row.volumeUsd6 += p.sizeUsd6;
    if (s === 2 || s === 3) row.open += 1;
    if (settled) {
      row.realizedFxrp += p.pnlFxrp < -p.marginFxrp ? -p.marginFxrp : p.pnlFxrp;
    }
    if (s === 5) row.liquidations += 1;
    by.set(p.owner, row);
  }
  const rows = [...by.values()].sort((a, b) =>
    b.realizedFxrp > a.realizedFxrp ? 1 : b.realizedFxrp < a.realizedFxrp ? -1 : b.trades - a.trades
  );
  return { rows, loading, preSeason };
}
