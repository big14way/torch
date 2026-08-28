import { useGlobalStats, fmtUsd6 } from "../lib/hooks";
import { FDC } from "../lib/config";
import { useRoute, Link } from "../lib/router";

/** First-run landing, shown only while no wallet is connected.
 *
 * House rules: no invented testimonials (live on-chain numbers instead),
 * testnet labelled, no yield promises, no em-dashes. Traders with a connected
 * wallet never see this section.
 *
 * Written for someone who has never read a protocol doc. Every claim here is
 * still exact, but the protocol names live on /verify, one click away, where a
 * skeptic can check them. A landing page that opens with "FTSOv2" loses the
 * reader before it earns the right to say it.
 */
export default function Landing() {
  const { volume, positions } = useGlobalStats();

  const { navigate } = useRoute();
  const scrollToApp = () => navigate("/trade");

  return (
    <section className="landing">
      {/* hero */}
      <div className="ld-hero">
        <h2>
          Trade with your XRP.
          <br />
          <span className="ld-grad">Check every number yourself.</span>
        </h2>
        <p className="ld-sub">
          Torch is a trading terminal for XRP holders. Put up XRP as margin, trade six markets up
          to 10x, and see exactly where every price came from. Three minutes to your first trade,
          and it costs nothing to try.
        </p>
        <div className="ld-cta-row">
          <button className="btn primary" onClick={scrollToApp}>
            Start trading free
          </button>
          <span className="ld-cta-note">Test network. Free practice funds, no real money.</span>
        </div>
      </div>

      {/* problem */}
      <div className="ld-problem">
        <b>You can already trade with your XRP. You just cannot check any of it.</b>
        <span>
          Every venue asks you to trust a dashboard: their price, their fill, their custody. If you
          held XRP through the years when trust was the whole argument, that should bother you.
        </span>
      </div>

      {/* features */}
      <div className="ld-features">
        <div className="ld-feat">
          <div className="ld-feat-t">Nobody here picks your price</div>
          <div className="ld-feat-d">
            Every trade settles against the price Flare itself publishes, the same one the whole
            network reads. A price more than 1.5% away from it gets rejected, and so does any price
            that would be worse for you than it. That is enforced by the contract, not promised in
            a policy.
          </div>
        </div>
        <div className="ld-feat">
          <div className="ld-feat-t">Your entry price is signed by sealed hardware</div>
          <div className="ld-feat-d">
            The price you open at is read and signed inside a locked machine that Flare's own
            validators vouch for. Torch's service pays the fee and presses send, and that is all it
            can do: it cannot change the number, cannot withdraw, and cannot touch your funds.{" "}
            <Link to="/verify">See how that is checked</Link>.
          </div>
        </div>
        <div className="ld-feat">
          <div className="ld-feat-t">Trades you can re-check afterwards</div>
          <div className="ld-feat-d">
            Flare's validators go back to the exchange, read the order again, and record on-chain
            that it really happened, on the right market and the right side. A receipt anyone can
            reproduce, not a number you take from us.{" "}
            {FDC.positionAttest ? (
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.positionAttest.tx}`}
                target="_blank"
                rel="noreferrer"
              >
                See a real receipt
              </a>
            ) : FDC.attestTx ? (
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.attestTx}`}
                target="_blank"
                rel="noreferrer"
              >
                See a real receipt
              </a>
            ) : (
              // Never interpolate a missing hash: a redeploy that regenerates
              // fdc.json without receipts once shipped a link to /tx/undefined.
              <Link to="/verify">See a real receipt</Link>
            )}
            . What it does not prove, and there is a list, sits on the{" "}
            <Link to="/verify">Verify page</Link> right beside what it does.
          </div>
        </div>
      </div>

      {/* who it's for + live proof */}
      <div className="ld-bottom">
        <div className="ld-who">
          <b>This is for you if</b>
          <ul>
            <li>You hold XRP and want to trade with it, not just park it for rewards.</li>
            <li>You read the contract before you read the marketing.</li>
            <li>You want a venue that publishes what it cannot prove, not just what it can.</li>
          </ul>
        </div>
        <div className="ld-proof">
          <b>Live, not claimed</b>
          <ul>
            <li>
              ${fmtUsd6(volume)} traded across {positions} positions, every one of them on-chain
            </li>
            <li>Season 1 of the trading league: 26 traders, 164 positions, zero made-up numbers</li>
            <li>
              The house account is public on the <Link to="/verify">Verify page</Link>: balance,
              payouts and the cap, live
            </li>
          </ul>
        </div>
      </div>

      <div className="ld-close">
        <span>
          Two seasons of the Paper Perps League are in the books: 28 wallets, 221 positions, all
          on-chain. Trade the current arena now, and Season 3 is taking shape.
        </span>
        <button className="btn primary" onClick={scrollToApp}>
          Open the terminal
        </button>
      </div>
    </section>
  );
}
