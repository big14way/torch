import { useReadContracts, usePublicClient, useWriteContract } from "wagmi";
import { DEPLOY, STATUS, VAULT, type Position } from "../lib/config";
import { fmtFxrp, fmtPx, fmtUsd6, livePnlUsd6, marketName, useXrpPrice, waitTx } from "../lib/hooks";

const MAINTENANCE = 0.05; // mirrors maintenanceMarginBps = 500

/** Estimated liquidation price + health for an open position.
 * Health is the equity's distance to the maintenance floor: 1 right after
 * open, 0 at liquidation. Holds XRP/USD constant; the contract re-marks live. */
function liqAndHealth(p: Position, mark: bigint | undefined, xrpPx: bigint | undefined) {
  if (!mark || !xrpPx || p.entryPrice6 === 0n) return null;
  const entry = Number(p.entryPrice6) / 1e6;
  const size = Number(p.sizeUsd6) / 1e6;
  const marginUsd = (Number(p.marginFxrp) / 1e6) * (Number(xrpPx) / 1e6);
  if (size <= 0 || marginUsd <= 0) return null;
  const liq = p.isLong
    ? entry * (1 + MAINTENANCE - marginUsd / size)
    : entry * (1 - MAINTENANCE + marginUsd / size);
  const pnlUsd = Number(livePnlUsd6(p, mark) ?? 0n) / 1e6;
  const equity = marginUsd + pnlUsd;
  const maint = size * MAINTENANCE;
  const denom = marginUsd - maint;
  const health = denom > 0 ? Math.max(0, Math.min(1, (equity - maint) / denom)) : 0;
  return { liq: Math.max(liq, 0), health };
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

  const act = async (fn: "requestClose" | "cancelRequest", id: bigint) => {
    try {
      const hash = await writeContractAsync({ ...VAULT, functionName: fn, args: [id] });
      await waitTx(publicClient, hash);
    } catch {
      // surfaced by wallet; table state refreshes on poll
    }
  };

  const rows = [...(positions ?? [])].reverse();

  if (rows.length === 0) {
    return <div className="empty">No positions yet. Deposit margin and light one up.</div>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
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
                    <span className={p.pnlFxrp >= 0n ? "pnl-pos" : "pnl-neg"}>
                      {p.pnlFxrp >= 0n ? "+" : ""}
                      {fmtFxrp(p.pnlFxrp)} FXRP
                    </span>
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
                    <button className="btn sm ghost" disabled={isPending} onClick={() => act("requestClose", p.id)}>
                      Close
                    </button>
                  )}
                  {requested && (
                    <button className="btn sm ghost" disabled={isPending} onClick={() => act("cancelRequest", p.id)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
