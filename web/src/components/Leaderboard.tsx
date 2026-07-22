import { useAccount } from "wagmi";
import { fmtFxrp, fmtUsd6, useLeaderboard, LEAGUE_DATES, LEAGUE_PRIZE, LEAGUE_SEASON, type LeagueRow } from "../lib/hooks";

const RANK = ["#1", "#2", "#3"];
const TOP = 10;

function Row({ r, rank, isYou }: { r: LeagueRow; rank: number; isYou: boolean }) {
  // below half a displayed cent either way, show a signless flat 0.00
  const flat = r.realizedFxrp < 5_000n && r.realizedFxrp > -5_000n;
  return (
    <tr className={isYou ? "league-you" : undefined}>
      <td className={`league-rank r${rank}`}>{RANK[rank - 1] ?? `#${rank}`}</td>
      <td className="mono">
        {r.owner.slice(0, 6)}...{r.owner.slice(-4)}
        {isYou && <span className="pill sm-pill">you</span>}
      </td>
      <td>
        {flat ? (
          <span>0.00 FXRP</span>
        ) : (
          <span className={r.realizedFxrp > 0n ? "pnl-pos" : "pnl-neg"}>
            {r.realizedFxrp > 0n ? "+" : ""}
            {fmtFxrp(r.realizedFxrp)} FXRP
          </span>
        )}
      </td>
      <td>{r.trades}</td>
      <td>${fmtUsd6(r.volumeUsd6, 0)}</td>
      <td>{r.liquidations}</td>
    </tr>
  );
}

/** Paper Perps League standings, ranked by realized PnL in FXRP.
 * Shows the top 10, plus the connected wallet's own row pinned below when it
 * ranks outside the cut — a trader who can't find themselves stops competing.
 * Reads straight from the vault; dark-palette and screenshot-friendly on
 * purpose (the league posts a leaderboard image twice a week). */
export default function Leaderboard() {
  const { rows, loading, preSeason } = useLeaderboard();
  const { address } = useAccount();

  const isYou = (r: LeagueRow) => !!address && r.owner.toLowerCase() === address.toLowerCase();
  const myIndex = rows.findIndex(isYou);
  const showMineBelow = myIndex >= TOP;

  return (
    <div className="card league">
      <div className="league-head">
        <h2>HALL OF FLAME</h2>
        <span className="league-prize">
          {LEAGUE_SEASON} · {LEAGUE_PRIZE} · {LEAGUE_DATES}
        </span>
        <span className="league-sub">
          {preSeason
            ? `Warm-up · all-time standings shown until ${LEAGUE_SEASON} opens ${LEAGUE_DATES.split(" – ")[0]}. Trade now to practice.`
            : `Paper Perps League ${LEAGUE_SEASON} · Coston2 testnet · ranked by realized PnL (losses capped at posted margin), liquidations held against you`}
        </span>
        <span className="league-rules">
          House &amp; team wallets appear on the board (they keep the plumbing honest) but can't
          win. On-vault profit payouts are capped at the live insurance fund; board ranking
          always uses full realized PnL.
        </span>
      </div>

      {loading ? (
        <div className="empty">Lighting the board...</div>
      ) : rows.length === 0 ? (
        <div className="empty">No settled trades yet. The league is warming up.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Trader</th>
                <th>Realized PnL</th>
                <th>Trades</th>
                <th>Volume</th>
                <th>Liqs</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, TOP).map((r, i) => (
                <Row key={r.owner} r={r} rank={i + 1} isYou={isYou(r)} />
              ))}
              {showMineBelow && (
                <>
                  <tr aria-hidden="true">
                    <td className="league-gap" colSpan={6}>
                      ···
                    </td>
                  </tr>
                  <Row r={rows[myIndex]} rank={myIndex + 1} isYou={true} />
                </>
              )}
            </tbody>
          </table>
          {showMineBelow && (
            <div className="league-note">
              You're ranked #{myIndex + 1} of {rows.length}. Only settled trades count — close a
              winner to climb.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
