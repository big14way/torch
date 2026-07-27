import { useEffect, useRef, useState } from "react";
import { DEPLOY } from "../lib/config";
import { fmtPx } from "../lib/hooks";
import { fetch24hChangePct } from "../lib/candles";

/** The market header every serious venue puts above the chart: selector,
 * headline mark price (ticking), 24h change, and Torch's own stat — the
 * on-chain FTSO band that bounds every settlement. */
export default function MarketStrip({
  marketKey,
  setMarketKey,
  mark,
}: {
  marketKey: string;
  setMarketKey: (k: string) => void;
  mark: bigint | undefined;
}) {
  const [pct, setPct] = useState<number | null>(null);
  const prev = useRef<bigint | undefined>(undefined);
  const [tick, setTick] = useState("");

  useEffect(() => {
    if (mark !== undefined && prev.current !== undefined && mark !== prev.current) {
      setTick(mark > prev.current ? "tick-up" : "tick-down");
      const t = setTimeout(() => setTick(""), 700);
      prev.current = mark;
      return () => clearTimeout(t);
    }
    prev.current = mark;
  }, [mark]);

  useEffect(() => {
    setPct(null);
    if (mark === undefined) return;
    let dead = false;
    fetch24hChangePct(marketKey, Number(mark) / 1e6).then((p) => {
      if (!dead) setPct(p);
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey, mark === undefined]);

  return (
    <div className="marketstrip card">
      <div className="markettabs" role="tablist" aria-label="Markets">
        {DEPLOY.markets.map((m) => (
          <button
            key={m.key}
            role="tab"
            aria-selected={m.key === marketKey}
            className={m.key === marketKey ? "active" : ""}
            onClick={() => setMarketKey(m.key)}
          >
            {m.key}-PERP
          </button>
        ))}
      </div>

      <div className="ms-price">
        <span className={`ms-mark ${tick}`}>{mark !== undefined ? `$${fmtPx(mark)}` : "..."}</span>
        {pct !== null && (
          <span className={`ms-delta ${pct >= 0 ? "up" : "down"}`}>
            {pct >= 0 ? "+" : ""}
            {pct.toFixed(2)}% <em>24h</em>
          </span>
        )}
      </div>

      <div className="spacer" />

      <div className="ms-meta">
        <span
          className="bandchip"
          title="Every settlement price must sit within 1.5% of Flare's FTSOv2 feed or the transaction reverts"
        >
          FTSO band ±1.5%
        </span>
        <span className="ms-lev">up to 10x</span>
      </div>
    </div>
  );
}
