import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { DEPLOY, FDC } from "./lib/config";
import { fmtPx, useMarkPrice, usePositions } from "./lib/hooks";
import { useRoute, Link } from "./lib/router";
import Header from "./components/Header";
import Chart from "./components/Chart";
import Ticket from "./components/Ticket";
import AccountPanel from "./components/AccountPanel";
import Positions from "./components/Positions";
import RouteTrace from "./components/RouteTrace";
import { HowItWorksContent } from "./components/HowItWorks";
import Stats from "./components/Stats";
import Leaderboard from "./components/Leaderboard";
import HouseBook from "./components/HouseBook";
import Landing from "./components/Landing";
import FeedbackNudge from "./components/FeedbackNudge";

export default function App() {
  const { path, navigate } = useRoute();
  const [marketKey, setMarketKey] = useState<string>(DEPLOY.markets[0]?.key ?? "XRP");
  const { address, status } = useAccount();

  const market = DEPLOY.markets.find((m) => m.key === marketKey)!;
  const { data: mark } = useMarkPrice(market.id);
  const { data: positions } = usePositions(address);

  // Returning connected traders land on the terminal, not the marketing page.
  // Gate on wagmi's reconnect settling first, or the landing flashes (and this
  // redirect would bounce every trader through it) on each hard refresh.
  useEffect(() => {
    if (path === "/" && address && status === "connected") navigate("/trade");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, address, status]);

  // Live tab titles: a ticking price on /trade reads as a real terminal from
  // the tab bar alone.
  useEffect(() => {
    if (path === "/trade" && mark !== undefined) {
      document.title = `$${fmtPx(mark as bigint)} ${marketKey} · Torch`;
    } else if (path === "/league") {
      document.title = "League · Torch";
    } else if (path === "/verify") {
      document.title = "Verify · Torch";
    } else {
      document.title = "Torch | XRP-margined perps on Flare";
    }
  }, [path, mark, marketKey]);

  return (
    <div className="app">
      <Header />

      {path === "/league" ? (
        <main className="page-narrow">
          <Leaderboard />
        </main>
      ) : path === "/verify" ? (
        <main className="page-narrow">
          <div className="card verify-card">
            <h2>HOW A TRADE TRAVELS</h2>
            <HowItWorksContent />
          </div>
          <RouteTrace positions={positions} />
          <HouseBook />
          <Stats />
          <div className="card verify-card">
            <h2>CHECK IT YOURSELF</h2>
            <ul className="verify-links">
              <li>
                Enclave status (executor key, attestation, loop heartbeat):{" "}
                <a
                  href="https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network"
                  target="_blank"
                  rel="noreferrer"
                >
                  live endpoint
                </a>
              </li>
              <li>
                Enclave-executed Hyperliquid fill, FDC-verified on-chain:{" "}
                <a
                  href={`https://coston2-explorer.flare.network/tx/${FDC.attestTx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  attestation tx
                </a>
              </li>
              {FDC.positionAttest && (
                <li>
                  Vault position #{FDC.positionAttest.positionId} bound to its real fill (oid{" "}
                  {FDC.positionAttest.oid}):{" "}
                  <a
                    href={`https://coston2-explorer.flare.network/tx/${FDC.positionAttest.tx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    proof tx
                  </a>
                </li>
              )}
              <li>
                TorchVault (source-verified):{" "}
                <a
                  href={`https://coston2-explorer.flare.network/address/${DEPLOY.vault}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {DEPLOY.vault}
                </a>
              </li>
              <li>
                FDC consumer (source-verified):{" "}
                <a
                  href={`https://coston2-explorer.flare.network/address/${FDC.fdcConsumer}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {FDC.fdcConsumer}
                </a>
              </li>
              <li>
                Everything else:{" "}
                <a href="https://github.com/big14way/torch" target="_blank" rel="noreferrer">
                  the repo, public since day one
                </a>
              </li>
            </ul>
          </div>
        </main>
      ) : path === "/trade" ? (
        <main>
          <FeedbackNudge positions={positions} />

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
            <div className="spacer" />
            <span
              className="bandchip"
              title="Every settlement price must sit within 1.5% of Flare's FTSOv2 feed or the transaction reverts"
            >
              FTSO band ±1.5%
            </span>
          </div>

          <div className="grid" id="terminal">
            <div className="area-chart card">
              <Chart marketKey={marketKey} mark={mark as bigint | undefined} positions={positions} />
            </div>

            <div className="area-ticket">
              <Ticket marketKey={marketKey} mark={mark as bigint | undefined} />
            </div>

            <div className="area-positions card">
              <h2>Positions</h2>
              <Positions positions={positions} />
            </div>

            <div className="area-rail">
              <AccountPanel />
              <RouteTrace positions={positions} />
              <div className="verify-nudge">
                Every claim above is checkable. <Link to="/verify">Verify →</Link>
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main>
          <Landing />
          <Stats />
        </main>
      )}

      <div className="footer">
        <span>Torch is testnet software. Not audited. Not investment advice.</span>
        <a href="https://t.me/+4bWN0yFjIUc4ZGNk" target="_blank" rel="noreferrer">Telegram community</a>
        <a href="https://x.com/torchxrponflare" target="_blank" rel="noreferrer">X</a>
        <a href="https://dev.flare.network" target="_blank" rel="noreferrer">Flare docs</a>
        <a href="https://hyperliquid.gitbook.io/hyperliquid-docs" target="_blank" rel="noreferrer">Hyperliquid docs</a>
        <a href="https://faucet.flare.network" target="_blank" rel="noreferrer">Coston2 faucet</a>
      </div>
    </div>
  );
}
