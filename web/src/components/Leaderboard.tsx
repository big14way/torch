import { useAccount } from "wagmi";
import { fmtFxrp, fmtUsd6, useLeaderboard } from "../lib/hooks";

const RANK = ["🔥", "🥈", "🥉"];

/** Paper Perps League standings, ranked by realized PnL in FXRP.
 * Reads straight from the vault; dark-palette and screenshot-friendly on
 * purpose (the league posts a leaderboard image twice a week). */
export default function Leaderboard() {
  const { rows, loading } = useLeaderboard();
  const { address } = useAccount();

  return (
    <div className="card league">
      <div className="league-head">
        <h2>HALL OF FLAME</h2>
        <span className="league-sub">
          Paper Perps League · Coston2 testnet · ranked by realized PnL (losses capped at posted
          margin), liquidations held against you
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
              {rows.slice(0, 10).map((r, i) => {
                const isYou = address && r.owner.toLowerCase() === address.toLowerCase();
                // below half a displayed cent either way, show a signless flat 0.00
                const flat = r.realizedFxrp < 5_000n && r.realizedFxrp > -5_000n;
                return (
                  <tr key={r.owner} className={isYou ? "league-you" : undefined}>
                    <td className={`league-rank r${i + 1}`}>{RANK[i] ?? `#${i + 1}`}</td>
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
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
