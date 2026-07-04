import { DEPLOY, type Position } from "../lib/config";

/**
 * The route trace is Torch's signature element. It renders the actual
 * architecture (Flare vault, TEE enclave, Hyperliquid book) and lights each
 * hop as the latest order moves through it, so the interop story is visible
 * in the product, not just the pitch deck.
 */
export default function RouteTrace({ positions }: { positions: Position[] | undefined }) {
  const latest = positions && positions.length > 0 ? positions[positions.length - 1] : undefined;

  const inFlight = latest?.status === 1 || latest?.status === 3; // Requested or Closing
  const filled = latest !== undefined && latest.entryPrice6 > 0n;
  const vaultLit = latest !== undefined;
  const teeLit = inFlight || filled;
  const hlLit = filled;

  const caption = !latest
    ? "Open a position and watch it travel."
    : latest.status === 1
      ? "Margin locked on Flare. The TEE agent is placing the order on Hyperliquid."
      : latest.status === 3
        ? "Close requested. The TEE agent is unwinding on Hyperliquid."
        : latest.status === 2
          ? "Filled on Hyperliquid. Settlement will come back through the FTSO price band."
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
          <div className="name">Hyperliquid</div>
          <div className="desc">deep orderbook fill</div>
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
    </div>
  );
}
