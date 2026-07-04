import { useState } from "react";
import { useAccount } from "wagmi";
import { DEPLOY } from "./lib/config";
import { useMarkPrice, usePositions } from "./lib/hooks";
import Header from "./components/Header";
import Chart from "./components/Chart";
import Ticket from "./components/Ticket";
import AccountPanel from "./components/AccountPanel";
import Positions from "./components/Positions";
import RouteTrace from "./components/RouteTrace";
import HowItWorks from "./components/HowItWorks";
import Stats from "./components/Stats";

export default function App() {
  const [marketKey, setMarketKey] = useState<string>(DEPLOY.markets[0]?.key ?? "XRP");
  const [showHow, setShowHow] = useState(false);
  const { address } = useAccount();

  const market = DEPLOY.markets.find((m) => m.key === marketKey)!;
  const { data: mark } = useMarkPrice(market.id);
  const { data: positions } = usePositions(address);

  return (
    <div className="app">
      <Header marketKey={marketKey} mark={mark as bigint | undefined} onHow={() => setShowHow(true)} />

      <Stats />

      <div className="grid">
        <div className="area-chart card">
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
          <Chart marketKey={marketKey} mark={mark as bigint | undefined} />
        </div>

        <div className="area-ticket">
          <Ticket marketKey={marketKey} mark={mark as bigint | undefined} />
        </div>

        <div className="area-positions card">
          <h2>Positions</h2>
          <Positions positions={positions} />
        </div>

        <div className="area-rail">
          <RouteTrace positions={positions} />
          <AccountPanel />
        </div>
      </div>

      <div className="footer">
        <span>Torch is testnet software. Not audited. Not investment advice.</span>
        <a href="https://dev.flare.network" target="_blank" rel="noreferrer">Flare docs</a>
        <a href="https://hyperliquid.gitbook.io/hyperliquid-docs" target="_blank" rel="noreferrer">Hyperliquid docs</a>
        <a href="https://faucet.flare.network" target="_blank" rel="noreferrer">Coston2 faucet</a>
      </div>

      {showHow && <HowItWorks onClose={() => setShowHow(false)} />}
    </div>
  );
}
