export default function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="How Torch works">
        <button className="btn ghost sm close" onClick={onClose}>
          Close
        </button>
        <h3>HOW TORCH WORKS</h3>
        <ol>
          <li>
            Deposit FXRP into the Torch vault on Flare. Your margin never leaves the chain.
          </li>
          <li>
            Open a long or short. The vault locks your margin and emits a request.
          </li>
          <li>
            An agent whose keys live inside a TEE mirrors your position on Hyperliquid's
            orderbook. The agent's exchange key has no withdrawal permission, so it can
            trade but never take custody.
          </li>
          <li>
            Every fill price the agent reports must sit inside a tight band around
            Flare's FTSOv2 feed, enforced by the contract. Out-of-band prices revert.
          </li>
          <li>
            Close whenever you like. PnL settles in FXRP on Flare: profits paid from the
            insurance fund, losses added to it.
          </li>
        </ol>
        <p>
          Honest v0 trust model: you are trusting a verifiable operator, not a black box.
          Roadmap: FDC Web2Json attestations of Hyperliquid fills, then migration to
          Flare's Protocol Managed Wallets when FCC ships, which replaces the single
          operator with a protocol-run quorum of TEEs.
        </p>
      </div>
    </div>
  );
}
