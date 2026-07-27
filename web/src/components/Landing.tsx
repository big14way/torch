import { useGlobalStats, fmtUsd6 } from "../lib/hooks";
import { FDC } from "../lib/config";

/** First-run landing, shown only while no wallet is connected.
 *
 * Copy produced with the landing-page-copy skill (hero / problem / features /
 * who-for / proof / CTA), adapted to house rules: no invented testimonials
 * (live on-chain numbers instead), testnet labelled, no yield promises,
 * no em-dashes. Traders with a connected wallet never see this section.
 */
export default function Landing() {
  const { volume, positions } = useGlobalStats();

  const scrollToApp = () => {
    document.getElementById("terminal")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <section className="landing">
      {/* hero */}
      <div className="ld-hero">
        <h2>
          Trade perps with your XRP.
          <br />
          <span className="ld-grad">Verify every settlement on-chain.</span>
        </h2>
        <p className="ld-sub">
          Torch is a perps terminal for XRP holders on Flare. Deposit FXRP as margin, trade six
          markets up to 10x, and check every price, key, and fill yourself. Three minutes to first
          trade, costs nothing on testnet.
        </p>
        <div className="ld-cta-row">
          <button className="btn primary" onClick={scrollToApp}>
            Start trading free
          </button>
          <span className="ld-cta-note">Testnet FXRP from the faucet. No deposit of real funds.</span>
        </div>
      </div>

      {/* problem */}
      <div className="ld-problem">
        <b>You can already trade perps with XRP. You just can't check any of it.</b>
        <span>
          Every venue asks you to trust a dashboard: their price, their fill, their custody. If you
          held XRP through the years when trust was the whole argument, that should bother you.
        </span>
      </div>

      {/* features */}
      <div className="ld-features">
        <div className="ld-feat">
          <div className="ld-feat-t">Prices the operator cannot invent</div>
          <div className="ld-feat-d">
            Every settlement is checked on-chain against Flare's FTSOv2 oracle. A price more than
            1.5% off the live feed makes the transaction revert. Not policy, code.
          </div>
        </div>
        <div className="ld-feat">
          <div className="ld-feat-t">Keys nobody holds, including us</div>
          <div className="ld-feat-d">
            The executor key was generated inside an attested Intel TDX enclave and has never left
            it. It can trade. It cannot withdraw.{" "}
            <a
              href="https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network"
              target="_blank"
              rel="noreferrer"
            >
              Check the enclave yourself
            </a>
            .
          </div>
        </div>
        <div className="ld-feat">
          <div className="ld-feat-t">Fills proven by Flare's validators</div>
          <div className="ld-feat-d">
            Flare's Data Connector re-fetches exchange fills and verifies them on-chain, bound to
            the exact position.{" "}
            {FDC.positionAttest ? (
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.positionAttest.tx}`}
                target="_blank"
                rel="noreferrer"
              >
                See a real proof
              </a>
            ) : (
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.attestTx}`}
                target="_blank"
                rel="noreferrer"
              >
                See a real proof
              </a>
            )}
            . Our word is not part of the trust model.
          </div>
        </div>
      </div>

      {/* who it's for + live proof */}
      <div className="ld-bottom">
        <div className="ld-who">
          <b>This is for you if</b>
          <ul>
            <li>You hold XRP and want to trade with it, not just park it for emissions.</li>
            <li>You read the contract before you read the marketing.</li>
            <li>You want a venue where "trust me" is never the answer.</li>
          </ul>
        </div>
        <div className="ld-proof">
          <b>Live, not claimed</b>
          <ul>
            <li>
              ${fmtUsd6(volume)} notional routed across {positions} positions, all on-chain
            </li>
            <li>Season 1 of the trading league: 26 traders, 164 positions, zero fake numbers</li>
            <li>House book published below: fund balance, payouts, and the cap, live</li>
          </ul>
        </div>
      </div>

      <div className="ld-close">
        <span>
          Season 2 of the Paper Perps League runs to Aug 5. Top 10 paid. The only thing at risk is
          your ego.
        </span>
        <button className="btn primary" onClick={scrollToApp}>
          Open the terminal
        </button>
      </div>
    </section>
  );
}
