import { DEPLOY, FDC, type Position } from "../lib/config";
import { marketName, useExecutorStatus } from "../lib/hooks";

/**
 * The route trace is Torch's signature element. It renders the actual
 * architecture and lights each hop as the latest order moves through it.
 *
 * The third hop is labelled from the enclave's OWN reported execution mode, not
 * from what we wish were true: while it runs in mock mode the agent fills at
 * the FTSO mark and no order reaches an exchange, so naming Hyperliquid as a
 * live hop would be a false claim. If the endpoint is unreachable we say so
 * rather than assuming the flattering case.
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
  // enclave is capable of going. Once filled, hlOid is ground truth (0 means it
  // settled at the FTSO mark); before that, infer from the market — no testnet
  // venue lists XRP, so an XRP order never reaches a book however the enclave
  // is configured.
  const latestKey = latest ? marketName(latest.market) : undefined;
  const venueListed = latestKey !== undefined && latestKey !== "XRP";
  const wentToVenue = filled ? latest!.hlOid > 0n : routesToExchange && venueListed;

  const caption = !latest
    ? "Open a position and watch it travel."
    : latest.status === 1
      ? routesToExchange && venueListed
        ? "Margin locked on Flare. The TEE agent is placing the fill on the exchange."
        : "Margin locked on Flare. The TEE agent is filling at the FTSO mark."
      : latest.status === 3
        ? "Close requested. The TEE agent is unwinding the position."
        : latest.status === 2
          ? "Filled inside the FTSO price band, settling back on Flare."
          : latest.status === 5
            ? "Position liquidated below maintenance margin. Settled on Flare."
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
          <div className="name">Flare vault</div>
          <div className="desc">FXRP margin, FTSO band</div>
        </div>
        <div className={`node ${teeLit ? "lit" : ""}`}>
          <div className="orb" />
          <div className="name">TEE agent</div>
          <div className="desc">sealed keys, no custody</div>
        </div>
        <div className={`node ${hlLit ? "lit" : ""}`}>
          <div className="orb" />
          <div className="name">
            {!latest ? (routesToExchange ? "Hyperliquid" : "Settlement mark") : wentToVenue ? "Hyperliquid" : "Settlement mark"}
          </div>
          <div className="desc">
            {!latest
              ? routesToExchange
                ? "hedge leg on the exchange book (venue-listed markets)"
                : "filled at the FTSO mark, no exchange leg yet"
              : wentToVenue
                ? "hedge leg on the exchange book"
                : routesToExchange
                  ? `${latestKey} is not listed on the venue — filled at the FTSO mark`
                  : status?.executionMode === "mock"
                    ? "filled at the FTSO mark, no exchange leg yet"
                    : "exchange routing unconfirmed"}
          </div>
        </div>
      </div>
      <div className="caption">{caption}</div>
      <div className="tee-badge">
        <span aria-hidden="true">◈</span>
        {DEPLOY.mode === "local" ? (
          "TEE: dev mode, local run, unattested"
        ) : (
          <>
            TEE: executor key sealed in a Phala TDX enclave, attested.{" "}
            <a
              href="https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network"
              target="_blank"
              rel="noreferrer"
            >
              verify
            </a>
          </>
        )}
      </div>
      {DEPLOY.mode === "coston2" && (FDC.positionAttest || FDC.attestTx) && (
        <div className="tee-badge">
          <span aria-hidden="true">✓</span>
          {FDC.positionAttest ? (
            <>
              FDC: vault position #{FDC.positionAttest.positionId} bound to its real Hyperliquid
              fill (oid {FDC.positionAttest.oid}) by Flare's validators.{" "}
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.positionAttest.tx}`}
                target="_blank"
                rel="noreferrer"
              >
                proof
              </a>
            </>
          ) : (
            <>
              FDC: a real Hyperliquid fill ({FDC.attestedCoin} #{FDC.attestedOid}) attested
              on-chain by Flare's validators.{" "}
              <a
                href={`https://coston2-explorer.flare.network/tx/${FDC.attestTx}`}
                target="_blank"
                rel="noreferrer"
              >
                proof
              </a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
