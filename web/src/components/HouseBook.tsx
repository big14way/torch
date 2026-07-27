import { useHouseBook, fmtFxrp, fmtUsd6 } from "../lib/hooks";

/** The house book, published.
 *
 * Every perps venue has a counterparty pool. Most don't show you it. Torch's
 * is a single on-chain number, so the whole book — what it holds, what it has
 * absorbed, what it has paid out, and the cap that applies to winners — is
 * stated plainly instead of being something a reader has to find in the code. */
export default function HouseBook() {
  const { insurance, absorbed, paidOut, feesUsd6, settled, coverageBps } = useHouseBook();

  const cov = coverageBps === null ? null : coverageBps / 100;
  const covClass = cov === null ? "" : cov >= 100 ? "ok" : cov >= 40 ? "warn" : "low";

  return (
    <div className="card housebook">
      <div className="hb-head">
        <h2>HOUSE BOOK</h2>
        <span className="hb-sub">
          The insurance fund is the counterparty to every trade. Losses accrue to it, winners are
          paid from it. Read live from the vault.
        </span>
      </div>

      <div className="hb-grid">
        <div className="hb-cell">
          <b>{fmtFxrp(insurance)}</b>
          <span>fund balance (FXRP)</span>
        </div>
        <div className="hb-cell">
          <b className={covClass}>{cov === null ? "—" : `${cov.toFixed(0)}%`}</b>
          <span>of open interest coverable</span>
        </div>
        <div className="hb-cell">
          <b className="ok">+{fmtFxrp(absorbed)}</b>
          <span>trader losses absorbed</span>
        </div>
        <div className="hb-cell">
          <b className="low">−{fmtFxrp(paidOut)}</b>
          <span>paid to winners</span>
        </div>
        <div className="hb-cell">
          <b>${fmtUsd6(feesUsd6)}</b>
          <span>fees charged ({settled} settled)</span>
        </div>
      </div>

      <div className="hb-note">
        Winner payouts are capped at the fund balance by the contract — if the fund is short, a
        winning position settles for less than its full PnL. The leaderboard always ranks on full
        realized PnL. No third party can deposit into this fund yet; it is operator-funded, and an
        LP seat is roadmap, not a product. Testnet.
      </div>
    </div>
  );
}
