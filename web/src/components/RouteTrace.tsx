import { DEPLOY, FDC, type Position } from "../lib/config";
import { marketName, useExecutorStatus } from "../lib/hooks";
import { Link } from "../lib/router";

/**
 * The route trace is Torch's signature element. It renders the actual
 * architecture and lights each hop as the latest order moves through it.
 *
 * The third hop is labelled from the service's OWN reported execution mode,
 * not from what we wish were true: while it runs in mock mode the order fills
 * at Flare's published price and nothing reaches an exchange, so naming
 * Hyperliquid as a live hop would be a false claim. If the endpoint is
 * unreachable we say so rather than assuming the flattering case.
 */
export default function RouteTrace({ positions }: { positions: Position[] | undefined }) {
  const latest = positions && positions.length > 0 ? positions[positions.length - 1] : undefined;
  const { status, routesToExchange } = useExecutorStatus();

  const inFlight = latest?.status === 1 || latest?.status === 3; // Requested or Closing
  const filled = latest !== undefined && latest.entryPrice6 > 0n;
  const vaultLit = latest !== undefined;
  const teeLit = inFlight || filled;
  const hlLit = filled;

  // The third hop must name where THIS position actually went, not where the
  // service is capable of going. Once filled, hlOid is ground truth (0 means it
  // settled at Flare's published price); before that, infer from the market --
  // no test exchange lists XRP, so an XRP order never reaches a book however
  // the service is configured.
  const latestKey = latest ? marketName(latest.market) : undefined;
  const venueListed = latestKey !== undefined && latestKey !== "XRP";
  const wentToVenue = filled ? latest!.hlOid > 0n : routesToExchange && venueListed;

  const caption = !latest
    ? "Open a position and watch it travel."
    : latest.status === 1
      ? routesToExchange && venueListed
        ? "Margin locked on Flare. Torch's service is placing the order on the exchange."
        : "Margin locked on Flare. Torch's service is filling it at Flare's published price."
      : latest.status === 3
        ? "Close requested. Torch's service is unwinding the position."
        : latest.status === 2
          ? "Filled close to Flare's published price, settling back on Flare."
          : latest.status === 5
            ? "Position closed out for running low on margin. Settled on Flare."
            : "Round trip complete. Margin settled back on Flare.";

  return (
    <div className="card trace">
      <h2>Order route</h2>
      <div className="nodes">
        <div className={`fuse ${inFlight ? "burning" : ""}`} aria-hidden="true">
          <div className="burn" style={!inFlight && filled ? { width: "100%" } : undefined} />
        </div>
        <div className={`node ${vaultLit ? "lit" : ""}`}>
          <div className="orb" />
          <div className="name">Vault on Flare</div>
          <div className="desc">holds your margin, checks the price</div>
        </div>
        <div className={`node ${teeLit ? "lit" : ""}`}>
          <div className="orb" />
          <div className="name">Torch service</div>
          <div className="desc">sends the order, holds nothing</div>
        </div>
        <div className={`node ${hlLit ? "lit" : ""}`}>
          <div className="orb" />
          <div className="name">
            {!latest
              ? routesToExchange
                ? "Hyperliquid"
                : "Flare price feed"
              : wentToVenue
                ? "Hyperliquid"
                : "Flare price feed"}
          </div>
          <div className="desc">
            {!latest
              ? routesToExchange
                ? "matching order on the exchange, where the market is listed"
                : "filled at Flare's published price, no exchange leg yet"
              : wentToVenue
                ? "matching order on the exchange"
                : routesToExchange
                  ? `${latestKey} is not listed on the exchange, so it filled at Flare's published price`
                  : status?.executionMode === "mock"
                    ? "filled at Flare's published price, no exchange leg yet"
                    : "exchange routing unconfirmed"}
          </div>
        </div>
      </div>
      <div className="caption">{caption}</div>
      <div className="tee-badge">
        <span aria-hidden="true">◈</span>
        {DEPLOY.mode === "local" ? (
          "Local test run. Nothing here is vouched for."
        ) : (
          <>
            Your entry price is signed inside a sealed machine that Flare's validators vouch for,
            and the vault checks that signature before it stores anything.{" "}
            <Link to="/verify">how this is checked</Link>
          </>
        )}
      </div>
      {DEPLOY.mode === "coston2" && (FDC.positionAttest || FDC.attestTx) && (
        <div className="tee-badge">
          <span aria-hidden="true">✓</span>
          {FDC.positionAttest ? (
            <>
              Flare's validators went back to the exchange and confirmed position #
              {FDC.positionAttest.positionId} against its real order (#{FDC.positionAttest.oid}).{" "}
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.positionAttest.tx}`}
                target="_blank"
                rel="noreferrer"
              >
                receipt
              </a>
            </>
          ) : (
            <>
              Flare's validators went back to the exchange and confirmed a real order (
              {FDC.attestedCoin} #{FDC.attestedOid}) on-chain.{" "}
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.attestTx}`}
                target="_blank"
                rel="noreferrer"
              >
                receipt
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
