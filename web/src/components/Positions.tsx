import { useState } from "react";
import { useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import { DEPLOY, STATUS, VAULT, type Position } from "../lib/config";
import {
  estLiqPrice,
  fmtFxrp,
  fmtPx,
  fmtUsd6,
  livePnlUsd6,
  marginMovesWithMark,
  marketName,
  MAINTENANCE_FRACTION,
  useEffectiveAccount,
  useXrpPrice,
  waitTx,
} from "../lib/hooks";

/** Estimated liquidation price + health for an open position.
 * Health is the equity's distance to the maintenance floor: 1 right after
 * open, 0 at liquidation. Liquidation price uses the coupled formula on
 * XRP-PERP, where margin is re-marked on the same feed as the mark. */
function liqAndHealth(p: Position, mark: bigint | undefined, xrpPx: bigint | undefined) {
  if (!mark || !xrpPx || p.entryPrice6 === 0n) return null;
  const entry = Number(p.entryPrice6) / 1e6;
  const size = Number(p.sizeUsd6) / 1e6;
  const marginFxrp = Number(p.marginFxrp) / 1e6;
  const marginUsd = marginFxrp * (Number(xrpPx) / 1e6);
  if (size <= 0 || marginUsd <= 0) return null;
  // Leverage for the liq estimate must be measured at entry, since sizeUsd6 was
  // fixed at open. On XRP-PERP the entry price *is* the XRP price at open, so
  // margin-at-entry is marginFxrp*entry; elsewhere fall back to the live mark.
  const coupled = marginMovesWithMark(marketName(p.market));
  const lev = coupled ? size / (marginFxrp * entry) : size / marginUsd;
  const liq = estLiqPrice(entry, lev, p.isLong, coupled);
  const pnlUsd = Number(livePnlUsd6(p, mark) ?? 0n) / 1e6;
  const equity = marginUsd + pnlUsd;
  const maint = size * MAINTENANCE_FRACTION;
  const denom = marginUsd - maint;
  const health = denom > 0 ? Math.max(0, Math.min(1, (equity - maint) / denom)) : 0;
  return { liq, health };
}

function useAllMarks(): Record<string, bigint | undefined> {
  const { data } = useReadContracts({
    contracts: DEPLOY.markets.map((m) => ({
      ...VAULT,
      functionName: "markPrice6",
      args: [m.id],
    })),
    query: { refetchInterval: 3000 },
  });
  const out: Record<string, bigint | undefined> = {};
  DEPLOY.markets.forEach((m, i) => {
    out[m.key] = data?.[i]?.status === "success" ? (data[i].result as bigint) : undefined;
  });
  return out;
}

export default function Positions({ positions }: { positions: Position[] | undefined }) {
  const marks = useAllMarks();
  const { data: xrpPx } = useXrpPrice();
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const { isConnected } = useEffectiveAccount();
  const [actErr, setActErr] = useState<string | null>(null);

  const act = async (fn: "requestClose" | "cancelRequest", id: bigint) => {
    setActErr(null);
    try {
      const hash = await writeContractAsync({ ...VAULT, functionName: fn, args: [id] });
      await waitTx(publicClient, hash);
    } catch (e) {
      // Previously swallowed entirely, so a revert or a wallet-less click gave
      // the user no feedback at all.
      const msg = e instanceof Error ? e.message : String(e);
      setActErr(
        msg.includes("User rejected") ? "Rejected in wallet." : msg.split("\n")[0].slice(0, 140)
      );
    }
  };

  const rows = [...(positions ?? [])].reverse();

  if (rows.length === 0) {
    return <div className="empty">No positions yet. Deposit margin and light one up.</div>;
  }

  return (
    <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Market</th>
            <th>Side</th>
            <th>Size</th>
            <th>Margin</th>
            <th>Entry</th>
            <th>Mark / Exit</th>
            <th>Liq / Health</th>
            <th>PnL</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const key = marketName(p.market);
            const mark = marks[key];
            const status = STATUS[p.status] ?? "?";
            const open = p.status === 2;
            const requested = p.status === 1;
            const done = p.status === 4 || p.status === 5;
            const live = open ? livePnlUsd6(p, mark) : null;
            const lh = open ? liqAndHealth(p, mark, xrpPx as bigint | undefined) : null;

            return (
              <tr key={p.id.toString()}>
                <td>{p.id.toString()}</td>
                <td>{key}-PERP</td>
                <td className={p.isLong ? "side-long" : "side-short"}>{p.isLong ? "LONG" : "SHORT"}</td>
                <td>${fmtUsd6(p.sizeUsd6)}</td>
                <td>{fmtFxrp(p.marginFxrp)} FXRP</td>
                <td>{p.entryPrice6 > 0n ? `$${fmtPx(p.entryPrice6)}` : "..."}</td>
                <td>
                  {done
                    ? p.exitPrice6 > 0n
                      ? `$${fmtPx(p.exitPrice6)}`
                      : "..."
                    : mark
                      ? `$${fmtPx(mark)}`
                      : "..."}
                </td>
                <td className="liqcell">
                  {lh ? (
                    <>
                      ${lh.liq.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                      <span
                        className="healthbar"
                        title={`health ${(lh.health * 100).toFixed(0)}%`}
                        style={{ marginLeft: 6 }}
                      >
                        <i
                          style={{
                            width: `${Math.round(lh.health * 100)}%`,
                            background:
                              lh.health > 0.5 ? "#3add9a" : lh.health > 0.2 ? "#ffc24b" : "#ff5470",
                          }}
                        />
                      </span>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {done ? (
                    (() => {
                      // The contract stores unclamped mark PnL but floors the
                      // payout at zero, so a hard liquidation would otherwise
                      // display a bigger loss than the user could actually take
                      // (and disagree with the leaderboard, which clamps).
                      const shown = p.pnlFxrp < -p.marginFxrp ? -p.marginFxrp : p.pnlFxrp;
                      return (
                        <span className={shown >= 0n ? "pnl-pos" : "pnl-neg"}>
                          {shown >= 0n ? "+" : ""}
                          {fmtFxrp(shown)} FXRP
                        </span>
                      );
                    })()
                  ) : live !== null ? (
                    <span className={live >= 0n ? "pnl-pos" : "pnl-neg"}>
                      {live >= 0n ? "+$" : "-$"}
                      {fmtUsd6(live >= 0n ? live : -live)}
                    </span>
                  ) : (
                    "..."
                  )}
                </td>
                <td>
                  <span className={`chip ${status}`}>{status}</span>
                </td>
                <td>
                  {open && (
                    <button className="btn sm ghost" disabled={isPending || !isConnected} onClick={() => act("requestClose", p.id)}>
                      Close
                    </button>
                  )}
                  {requested && (
                    <button className="btn sm ghost" disabled={isPending || !isConnected} onClick={() => act("cancelRequest", p.id)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {actErr && <div className="notice error">{actErr}</div>}
    </div>
  );
}
