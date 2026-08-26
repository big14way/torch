import { useGlobalStats, fmtUsd6, fmtFxrp } from "../lib/hooks";

/** Live numbers, read straight from the vault on-chain. */
export default function Stats() {
  const { insurance, openInterest, volume, openCount } = useGlobalStats();
  return (
    <div className="protostats" aria-live="polite">
      <div className="stat">
        <b>${fmtUsd6(volume)}</b>
        <span>traded</span>
      </div>
      <div className="stat">
        <b>${fmtUsd6(openInterest)}</b>
        <span>open right now</span>
      </div>
      <div className="stat">
        <b>{fmtFxrp(insurance)}</b>
        <span>insurance fund (FXRP)</span>
      </div>
      <div className="stat">
        <b>{openCount}</b>
        <span>open positions</span>
      </div>
    </div>
  );
}
