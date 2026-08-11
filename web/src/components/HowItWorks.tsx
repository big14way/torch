import { FDC } from "../lib/config";

/** The five-step trust walk. Rendered at the top of the /verify page.
 * (Previously a modal; promoted to a page so the differentiator has a URL.) */
export function HowItWorksContent() {
  // Link the CURRENT receipt, not a hardcoded one: a consumer redeploy moved
  // these once already and left the page pointing at a retired contract.
  const receiptTx = FDC.positionAttest?.tx ?? FDC.attestTx;
  return (
    <div className="howworks">
      <ol>
        <li>Deposit FXRP into the Torch vault on Flare. Your margin never leaves the chain.</li>
        <li>Open a long or short. The vault locks your margin and emits a request.</li>
        <li>
          An agent whose keys live inside a TEE mirrors your position on Hyperliquid's orderbook —
          on markets the venue lists; XRP is not one of them yet, so those fill at the FTSO mark.
          The agent's exchange key has no withdrawal permission, so it can trade but never take
          custody.
        </li>
        <li>
          Every fill price the agent reports must sit inside a tight band around Flare's FTSOv2
          feed, enforced by the contract. Out-of-band prices revert.
        </li>
        <li>
          Close whenever you like. PnL settles in FXRP on Flare: profits paid from the insurance
          fund, losses added to it.
        </li>
      </ol>
      <p>
        Honest v0 trust model: you are trusting a verifiable operator, not a black box. The path
        off the operator's word is already live and automatic: the enclave runs Flare's Data
        Connector (Web2Json) itself on every venue-routed fill, binding it to the vault position
        on-chain
        {receiptTx ? (
          <>
            ,{" "}
            <a
              href={`https://coston2-explorer.flare.network/tx/${receiptTx}`}
              target="_blank"
              rel="noreferrer"
            >
              verified by Flare's validators here
            </a>
          </>
        ) : null}
        . And the port onto Flare Confidential Compute is now running: a Flare Compute
        Extension (Coston2, extension 66154) takes an instruction submitted on-chain through a
        registered InstructionSender contract, fetches the Hyperliquid fill from inside the
        enclave, and signs it. The remaining step is gating the vault on that signature, so that
        no single operator can invent a fill price. Protocol
        Managed Wallets, still in development, are the eventual endgame.
      </p>
    </div>
  );
}
