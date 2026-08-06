import { useEffect, useRef, useState } from "react";
import { parseUnits } from "viem";
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
  usePayoutCaps,
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

/** "1h 23m" / "9m" for the self-close countdown. Round to whole minutes
 * first, then split, so 7195s reads "2h 0m" rather than "1h 60m". */
function fmtDur(totalSec: number): string {
  const mins = Math.ceil(Math.max(0, totalSec) / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Positions({ positions }: { positions: Position[] | undefined }) {
  const marks = useAllMarks();
  const { data: xrpPx } = useXrpPrice();
  const caps = usePayoutCaps();
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();
  const { isConnected } = useEffectiveAccount();
  const [actErr, setActErr] = useState<string | null>(null);

  // Self-close metadata for rows stuck in CloseRequested: the vault's delay
  // plus each row's request timestamp drive the countdown to the escape hatch.
  // All values normalized to Number at decode time — closeRequestedAt is a
  // uint40 (viem decodes it as number) while selfCloseDelay is a uint64
  // (bigint); mixing them throws. Seconds fit far below 2^53.
  // Last-good merge: individual calls inside the batch can fail under the
  // rate-limited public RPC (same mode useAllPositions guards against), and
  // these buttons must not blank for the user they exist to rescue.
  const closingIds = (positions ?? []).filter((p) => p.status === 3).map((p) => p.id);
  const requestedIds = (positions ?? []).filter((p) => p.status === 1).map((p) => p.id);
  const openIds = (positions ?? []).filter((p) => p.status === 2).map((p) => p.id);
  const { data: closeMeta } = useReadContracts({
    contracts: [
      { ...VAULT, functionName: "selfCloseDelay" },
      { ...VAULT, functionName: "acceptTimeout" },
      ...closingIds.map((id) => ({ ...VAULT, functionName: "closeRequestedAt", args: [id] })),
      ...requestedIds.map((id) => ({ ...VAULT, functionName: "fillAcceptedAt", args: [id] })),
      ...openIds.map((id) => ({ ...VAULT, functionName: "triggers", args: [id] })),
    ],
    query: {
      refetchInterval: 10_000,
      enabled: closingIds.length + requestedIds.length + openIds.length > 0,
      // NO keepPreviousData here: the id lists are recomputed every render,
      // and serving a previous key's results against fresh positional offsets
      // misattributes slots (and once crashed on destructuring a scalar as
      // the triggers tuple). While the new key loads, the lastGood ref below
      // keeps the buttons from blanking — the safe half of the old behavior.
    },
  });
  const lastGood = useRef<{
    delay?: number;
    acceptTimeout?: number;
    at: Record<string, number>;
    acceptedAt: Record<string, number>;
    trig: Record<string, { stop: bigint; tp: bigint }>;
  }>({ at: {}, acceptedAt: {}, trig: {} });
  // Shape guards on every slot: a slot must be the type its region expects
  // before it is consumed — the belt to the no-keepPreviousData suspenders.
  const isScalar = (v: unknown): v is number | bigint =>
    typeof v === "number" || typeof v === "bigint";
  if (closeMeta?.[0]?.status === "success" && isScalar(closeMeta[0].result))
    lastGood.current.delay = Number(closeMeta[0].result);
  if (closeMeta?.[1]?.status === "success" && isScalar(closeMeta[1].result))
    lastGood.current.acceptTimeout = Number(closeMeta[1].result);
  closingIds.forEach((id, i) => {
    const r = closeMeta?.[i + 2];
    if (r?.status === "success" && isScalar(r.result))
      lastGood.current.at[id.toString()] = Number(r.result);
  });
  requestedIds.forEach((id, i) => {
    const r = closeMeta?.[i + 2 + closingIds.length];
    if (r?.status === "success" && isScalar(r.result))
      lastGood.current.acceptedAt[id.toString()] = Number(r.result);
  });
  openIds.forEach((id, i) => {
    const r = closeMeta?.[i + 2 + closingIds.length + requestedIds.length];
    if (r?.status === "success" && Array.isArray(r.result) && r.result.length === 2) {
      const [stop, tp] = r.result as unknown as readonly [bigint, bigint];
      if (typeof stop === "bigint" && typeof tp === "bigint")
        lastGood.current.trig[id.toString()] = { stop, tp };
    }
  });
  const selfCloseDelay = lastGood.current.delay;
  const acceptTimeout = lastGood.current.acceptTimeout;
  const closeReqAt = lastGood.current.at;
  const acceptedAt = lastGood.current.acceptedAt;
  const trigOf = lastGood.current.trig;
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const needsTick = closingIds.length + requestedIds.length > 0;
  useEffect(() => {
    if (!needsTick) return;
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 10_000);
    return () => clearInterval(t);
  }, [needsTick]);

  // SL/TP inline editor state (one open editor at a time).
  const [trigFor, setTrigFor] = useState<string | null>(null);
  const [stopStr, setStopStr] = useState("");
  const [tpStr, setTpStr] = useState("");
  // Values passed explicitly: reading stopStr/tpStr from the closure made
  // "Clear" re-submit the prefilled old triggers (state updates don't land
  // until the next render).
  const saveTriggers = async (id: bigint, isLong: boolean, stopS: string, tpS: string) => {
    setActErr(null);
    try {
      const stop6 = stopS ? parseUnits(stopS as `${number}`, 6) : 0n;
      const tp6 = tpS ? parseUnits(tpS as `${number}`, 6) : 0n;
      if (stop6 !== 0n && tp6 !== 0n && (isLong ? stop6 >= tp6 : stop6 <= tp6)) {
        setActErr(
          isLong
            ? "For a long, the stop must sit below the take-profit."
            : "For a short, the stop must sit above the take-profit."
        );
        return;
      }
      const hash = await writeContractAsync({
        ...VAULT,
        functionName: "setTriggers",
        args: [id, stop6, tp6],
      });
      await waitTx(publicClient, hash);
      setTrigFor(null);
      setStopStr("");
      setTpStr("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setActErr(msg.includes("User rejected") ? "Rejected in wallet." : msg.split("\n")[0].slice(0, 140));
    }
  };

  const act = async (
    fn: "requestClose" | "cancelRequest" | "cancelCloseRequest" | "selfClose",
    id: bigint
  ) => {
    setActErr(null);
    try {
      const hash = await writeContractAsync({ ...VAULT, functionName: fn, args: [id] });
      await waitTx(publicClient, hash);
    } catch (e) {
      // Previously swallowed entirely, so a revert or a wallet-less click gave
      // the user no feedback at all.
      const msg = e instanceof Error ? e.message : String(e);
      setActErr(
        msg.includes("User rejected")
          ? "Rejected in wallet."
          : msg.includes("TooSoon")
            ? fn === "selfClose"
              ? "Self-close hasn't unlocked yet: the full delay since your close request must elapse in chain time - your clock may be slightly ahead."
              : "The executor already accepted this fill, so cancelling is locked until the accept timeout elapses."
            : msg.includes("NotPositionOwner")
              ? "Only the position's owner can do that (watch mode is read-only)."
              : msg.includes("BadStatus")
                ? "The position changed state before the transaction landed - it may already be settled. Refreshing."
                : msg.split("\n")[0].slice(0, 140)
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
            const closing = p.status === 3;
            const done = p.status === 4 || p.status === 5;
            const live = open ? livePnlUsd6(p, mark) : null;
            const lh = open ? liqAndHealth(p, mark, xrpPx as bigint | undefined) : null;

            return (
              <tr key={p.id.toString()}>
                <td>{p.id.toString()}</td>
                <td>
                  {key}-PERP
                  {p.entryPrice6 > 0n && (
                    <span
                      style={{ marginLeft: 5, fontSize: 10, opacity: 0.65 }}
                      title={
                        p.hlOid > 0n
                          ? `Venue-routed: real Hyperliquid order #${p.hlOid} — FDC-attestable`
                          : "Filled at the FTSO oracle mark (no venue lists this market on testnet) — nothing to attest"
                      }
                    >
                      {p.hlOid > 0n ? "HL" : "FTSO"}
                    </span>
                  )}
                </td>
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
                      const cap = caps.get(p.id.toString());
                      return (
                        <>
                          <span className={shown >= 0n ? "pnl-pos" : "pnl-neg"}>
                            {shown >= 0n ? "+" : ""}
                            {fmtFxrp(shown)} FXRP
                          </span>
                          {cap && (
                            <div
                              style={{ fontSize: 10, opacity: 0.8, color: "#ffc24b" }}
                              title="The insurance fund could not cover the full win at settlement; the vault pays winners only from that fund and says so up front on /verify."
                            >
                              paid {fmtFxrp(cap.paid)} — capped by insurance fund
                            </div>
                          )}
                        </>
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
                  <span
                    className={`chip ${status}`}
                    title={
                      closing
                        ? "Still marked to market: a closing position can be liquidated until it settles."
                        : undefined
                    }
                  >
                    {status}
                  </span>
                  {closing && (
                    <div style={{ fontSize: 10, opacity: 0.7 }}>still liquidatable</div>
                  )}
                </td>
                <td>
                  {open &&
                    (() => {
                      const t = trigOf[p.id.toString()];
                      const hasTrig = t && (t.stop !== 0n || t.tp !== 0n);
                      const editing = trigFor === p.id.toString();
                      return (
                        <>
                          <button className="btn sm ghost" disabled={isPending || !isConnected} onClick={() => act("requestClose", p.id)}>
                            Close
                          </button>
                          <button
                            className="btn sm ghost"
                            disabled={!isConnected}
                            title="Set a stop-loss / take-profit. The contract re-reads the FTSO feed and only settles when the trigger genuinely crossed."
                            onClick={() => {
                              if (editing) {
                                setTrigFor(null);
                              } else {
                                setTrigFor(p.id.toString());
                                // plain digits: fmtPx's locale separators would
                                // break parseUnits on the way back in
                                setStopStr(t && t.stop !== 0n ? (Number(t.stop) / 1e6).toString() : "");
                                setTpStr(t && t.tp !== 0n ? (Number(t.tp) / 1e6).toString() : "");
                              }
                            }}
                          >
                            SL/TP
                          </button>
                          {hasTrig && !editing && (
                            <div style={{ fontSize: 10, opacity: 0.75 }}>
                              {t.stop !== 0n ? `SL $${fmtPx(t.stop)}` : ""}
                              {t.stop !== 0n && t.tp !== 0n ? " · " : ""}
                              {t.tp !== 0n ? `TP $${fmtPx(t.tp)}` : ""}
                            </div>
                          )}
                          {editing && (
                            <div style={{ display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" }}>
                              <input
                                style={{ width: 74 }}
                                placeholder="stop $"
                                value={stopStr}
                                onChange={(e) => setStopStr(e.target.value)}
                              />
                              <input
                                style={{ width: 74 }}
                                placeholder="take $"
                                value={tpStr}
                                onChange={(e) => setTpStr(e.target.value)}
                              />
                              <button className="btn sm" disabled={isPending} onClick={() => saveTriggers(p.id, p.isLong, stopStr, tpStr)}>
                                Set
                              </button>
                              {hasTrig && (
                                <button
                                  className="btn sm ghost"
                                  disabled={isPending}
                                  onClick={() => {
                                    setStopStr("");
                                    setTpStr("");
                                    void saveTriggers(p.id, p.isLong, "", "");
                                  }}
                                >
                                  Clear
                                </button>
                              )}
                            </div>
                          )}
                        </>
                      );
                    })()}
                  {requested &&
                    (() => {
                      const acc = acceptedAt[p.id.toString()];
                      const lockedUntil =
                        acc && acc > 0 && acceptTimeout !== undefined ? acc + acceptTimeout : undefined;
                      const locked = lockedUntil !== undefined && nowSec < lockedUntil;
                      return (
                        <button
                          className="btn sm ghost"
                          disabled={isPending || !isConnected || locked}
                          title={
                            locked
                              ? "The executor accepted this fill and may already be hedging it; cancel unlocks when the accept window lapses."
                              : "Withdraw the request before it fills. Free."
                          }
                          onClick={() => act("cancelRequest", p.id)}
                        >
                          {locked ? `Cancel in ${fmtDur(lockedUntil! - nowSec)}` : "Cancel"}
                        </button>
                      );
                    })()}
                  {closing &&
                    (() => {
                      const at = closeReqAt[p.id.toString()];
                      const unlockAt =
                        at !== undefined && at > 0 && selfCloseDelay !== undefined
                          ? at + selfCloseDelay
                          : undefined;
                      const ready = unlockAt !== undefined && nowSec >= unlockAt;
                      const remaining = unlockAt !== undefined ? unlockAt - nowSec : null;
                      return (
                        <>
                          <button
                            className="btn sm ghost"
                            disabled={isPending || !isConnected}
                            title="Retract your close request and go back to Open. Free, always available."
                            onClick={() => act("cancelCloseRequest", p.id)}
                          >
                            Cancel close
                          </button>
                          <button
                            className="btn sm ghost"
                            disabled={isPending || !isConnected || !ready}
                            title={
                              ready
                                ? "Settle yourself at the live FTSO oracle price - no executor needed."
                                : "If the executor doesn't answer your close, this unlocks and settles you at the oracle price."
                            }
                            onClick={() => act("selfClose", p.id)}
                          >
                            {ready
                              ? "Self-close at oracle"
                              : remaining !== null && remaining > 0
                                ? `Self-close in ${fmtDur(remaining)}`
                                : "Self-close"}
                          </button>
                        </>
                      );
                    })()}
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
