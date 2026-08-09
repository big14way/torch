import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { DEPLOY, FDC } from "./lib/config";
import { fmtPx, useEffectiveAccount, useMarkPrice, usePositions } from "./lib/hooks";
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
import Honesty from "./components/Honesty";
import Landing from "./components/Landing";
import FeedbackNudge from "./components/FeedbackNudge";
import MarketStrip from "./components/MarketStrip";

export default function App() {
  const { path, navigate } = useRoute();
  const [marketKey, setMarketKey] = useState<string>(DEPLOY.markets[0]?.key ?? "XRP");
  const { address, status } = useAccount();
  const { address: viewAddress, watching } = useEffectiveAccount();

  const market = DEPLOY.markets.find((m) => m.key === marketKey)!;
  const { data: mark } = useMarkPrice(market.id);
  const { data: positions } = usePositions(viewAddress);

  // Returning connected traders land on the terminal, not the marketing page.
  // Gate on wagmi's reconnect settling first, or the landing flashes (and this
  // redirect would bounce every trader through it) on each hard refresh.
  // Watchers (XRPL smart-account viewers) get the same treatment.
  useEffect(() => {
    if (path === "/" && ((address && status === "connected") || watching)) navigate("/trade");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, address, status, watching]);

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
    <div className={path === "/trade" ? "app app-terminal" : "app"}>
      <Header />

      {path === "/league" ? (
        <main className="page-narrow">
          <div className="pagehero">
            <div className="ph-eyebrow">Paper Perps League</div>
            <h2 className="ph-title">
              Season 2 <span className="ph-grad">is complete.</span>
            </h2>
            <p className="ph-sub">
              Jul 22 – Aug 5 · $150 in FXRP · top 10 paid. Two seasons, 28 wallets, 221 positions
              on the retired v1 vault — every one on-chain. The v2 arena is open for free trading
              while Season 3 takes shape.
            </p>
            <div className="ph-actions">
              <Link to="/trade" className="btn primary">Enter the arena</Link>
              <a className="btn ghost" href="https://faucet.flare.network" target="_blank" rel="noreferrer">
                Get free FXRP
              </a>
            </div>
          </div>
          <Leaderboard />
        </main>
      ) : path === "/verify" ? (
        <main className="page-narrow">
          <div className="pagehero">
            <div className="ph-eyebrow">Verify, don't trust</div>
            <h2 className="ph-title">
              Check it <span className="ph-grad">yourself.</span>
            </h2>
            <p className="ph-sub">
              Every settlement price is bounded on-chain against Flare's oracle, and must not be
              worse for you than the oracle itself. The signing key was generated inside attested
              hardware and can settle trades but never withdraw. Flare's validators can re-prove an
              exchange fill on-chain after the fact. Here is where you check each of those, and
              where we say plainly what is not yet proven.
            </p>
          </div>
          <div className="card verify-card">
            <h2>HOW A TRADE TRAVELS</h2>
            <HowItWorksContent />
          </div>
          <RouteTrace positions={positions} />
          <Honesty />
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
              {FDC.attestTx && (
                <li>
                  Every venue-routed fill is re-proved by Flare's validators and bound to its vault
                  position on-chain — run by the enclave itself, not by us on demand:{" "}
                  <a
                    href={`https://coston2-explorer.flare.network/tx/${FDC.attestTx}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    attestation tx
                  </a>
                </li>
              )}
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
                Margin funded from a bare XRPL wallet, one signature, via Flare Smart Accounts:{" "}
                <a
                  href="https://testnet.xrpl.org/transactions/BE8301336DA71C7B488BDC0C1006051599E439D50FC2F492CB334659766B94F7"
                  target="_blank"
                  rel="noreferrer"
                >
                  the XRPL signature
                </a>{" "}
                →{" "}
                <a
                  href="https://coston2-explorer.flare.network/tx/0xbaf5241608039406d307cdb46a6fcd1a55ad42b3fd31608bf077dd12b0298fee"
                  target="_blank"
                  rel="noreferrer"
                >
                  one Coston2 tx: mint, approve, deposit
                </a>
              </li>
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

          <MarketStrip marketKey={marketKey} setMarketKey={setMarketKey} mark={mark as bigint | undefined} />

          <div className="grid" id="terminal">
            <div className="area-chart card">
              <Chart marketKey={marketKey} mark={mark as bigint | undefined} positions={positions} />
            </div>

            <div className="area-positions card">
              <h2>Positions</h2>
              <Positions positions={positions} />
            </div>

            <div className="area-rail">
              <Ticket marketKey={marketKey} mark={mark as bigint | undefined} />
              <div className="rail-scroll">
                <AccountPanel />
                <RouteTrace positions={positions} />
                <div className="verify-nudge">
                  Every claim above is checkable. <Link to="/verify">Verify →</Link>
                </div>
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
