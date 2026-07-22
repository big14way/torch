import { useMemo, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits } from "viem";
import { DEPLOY, VAULT } from "../lib/config";
import { fmtFxrp, fmtPx, useFreeMargin, useXrpPrice, waitTx } from "../lib/hooks";

const MAINTENANCE = 0.05; // mirrors maintenanceMarginBps = 500
const MIN_NOTIONAL_USD = 10; // Hyperliquid rejects orders under ~$10 notional

export default function Ticket({ marketKey, mark }: { marketKey: string; mark: bigint | undefined }) {
  const { address, isConnected } = useAccount();
  const { data: free } = useFreeMargin(address);
  const { data: xrpPx } = useXrpPrice();
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();

  const [isLong, setIsLong] = useState(true);
  const [marginStr, setMarginStr] = useState("10"); // matches one faucet claim (~10 FXRP)
  const [levX10, setLevX10] = useState(30); // 3x default
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const market = DEPLOY.markets.find((m) => m.key === marketKey)!;

  const est = useMemo(() => {
    const margin = parseFloat(marginStr) || 0;
    const xrp = xrpPx ? Number(xrpPx) / 1e6 : 0;
    const px = mark ? Number(mark) / 1e6 : 0;
    const marginUsd = margin * xrp;
    const lev = levX10 / 10;
    const sizeUsd = marginUsd * lev;
    const openFee = sizeUsd * 0.0008;
    // liq estimate holds XRP/USD constant; the contract re-marks live
    const liqPx = px
      ? isLong
        ? px * (1 + MAINTENANCE - 1 / lev)
        : px * (1 - MAINTENANCE + 1 / lev)
      : 0;
    return { marginUsd, sizeUsd, openFee, liqPx, lev };
  }, [marginStr, levX10, isLong, mark, xrpPx]);

  const marginWei = useMemo(() => {
    try {
      return parseUnits((marginStr || "0") as `${number}`, 6);
    } catch {
      return 0n;
    }
  }, [marginStr]);

  const insufficient = free !== undefined && marginWei > free;
  const belowMin = est.sizeUsd > 0 && est.sizeUsd < MIN_NOTIONAL_USD;
  // Connected but nothing deposited yet: the #1 reason a first-time user can't
  // trade. Positions draw on *deposited* margin, not the wallet balance.
  const needsDeposit = isConnected && free !== undefined && free === 0n;

  const submit = async () => {
    setError(null);
    setSent(false);
    try {
      const hash = await writeContractAsync({
        ...VAULT,
        functionName: "openPosition",
        args: [market.id, isLong, marginWei, levX10],
        // openPosition reads the live FTSO feed (_fxrpToUsd6). eth_estimateGas
        // under-estimates FTSO-reading txs on Flare, causing intermittent
        // out-of-gas reverts. Pin a generous limit (caller pays only gas used).
        gas: 3_000_000n,
      });
      await waitTx(publicClient, hash);
      setSent(true);
      setTimeout(() => setSent(false), 4000);
    } catch (e) {
      setError(shortErr(e));
    }
  };

  return (
    <div className="card">
      <h2>New position</h2>

      {needsDeposit && (
        <div className="deposit-hint">
          <b>Deposit margin to start.</b> Positions trade on FXRP you've deposited into the vault,
          not your wallet balance. Need FXRP?{" "}
          <a href="https://faucet.flare.network" target="_blank" rel="noreferrer">
            Claim C2FLR + FTestXRP
          </a>{" "}
          (free), then <b>Deposit</b> in the Account panel{DEPLOY.mode === "coston2" ? " below" : ""}.
        </div>
      )}

      <div className="sideswitch" role="radiogroup" aria-label="Direction">
        <button className={`long ${isLong ? "on" : ""}`} onClick={() => setIsLong(true)}>
          LONG
        </button>
        <button className={`short ${!isLong ? "on" : ""}`} onClick={() => setIsLong(false)}>
          SHORT
        </button>
      </div>

      <div className="field">
        <label htmlFor="margin">
          Margin (FXRP)
          <span
            className="hint"
            onClick={() => free !== undefined && setMarginStr((Number(free) / 1e6).toString())}
          >
            free: {free !== undefined ? fmtFxrp(free) : "..."}
          </span>
        </label>
        <input
          id="margin"
          type="text"
          inputMode="decimal"
          value={marginStr}
          onChange={(e) => setMarginStr(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="100"
        />
      </div>

      <div className="field">
        <label htmlFor="lev">
          Leverage <span>{(levX10 / 10).toFixed(1)}x</span>
        </label>
        <input
          id="lev"
          type="range"
          min={10}
          max={100}
          step={5}
          value={levX10}
          onChange={(e) => setLevX10(parseInt(e.target.value))}
        />
        <div className="levmarks">
          <span>1x</span>
          <span>2.5x</span>
          <span>5x</span>
          <span>7.5x</span>
          <span>10x</span>
        </div>
      </div>

      <div className="ticket-summary">
        <div className="row">
          <span>Position size</span>
          <b>${est.sizeUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>
        </div>
        {belowMin && (
          <div className="row" style={{ color: "#ff5470" }}>
            <span>Minimum order</span>
            <b>${MIN_NOTIONAL_USD}, raise margin or leverage</b>
          </div>
        )}
        <div className="row">
          <span>Margin value</span>
          <b>${est.marginUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>
        </div>
        <div className="row">
          <span>Est. liq price</span>
          <b>{est.liqPx > 0 ? `$${est.liqPx.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : "..."}</b>
        </div>
        <div className="row">
          <span>Open fee (0.08%)</span>
          <b>${est.openFee.toLocaleString("en-US", { maximumFractionDigits: 2 })}</b>
        </div>
        <div className="row">
          <span>Route</span>
          <b>Flare vault, TEE, Hyperliquid</b>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <button
          className={`btn ${isLong ? "long" : "short"}`}
          style={{ width: "100%", padding: "12px" }}
          disabled={!isConnected || isPending || marginWei === 0n || insufficient || belowMin}
          onClick={submit}
        >
          {!isConnected
            ? "Connect wallet first"
            : needsDeposit
              ? "Deposit margin first"
              : insufficient
                ? `Not enough margin — ${free !== undefined ? fmtFxrp(free) : "0"} free`
                : belowMin
                  ? `Below $${MIN_NOTIONAL_USD} exchange minimum`
                  : isPending
                    ? "Confirm in wallet..."
                    : `${isLong ? "Long" : "Short"} ${marketKey} at ${mark ? `$${fmtPx(mark)}` : "..."}`}
        </button>
      </div>

      {sent && <div className="notice">Request sent. The TEE agent is filling it on the exchange. Watch the route trace.</div>}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

function shortErr(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("User rejected")) return "Transaction rejected in wallet.";
  return msg.split("\n")[0].slice(0, 160);
}
