/** The five-step trust walk. Rendered at the top of the /verify page.
 * (Previously a modal; promoted to a page so the differentiator has a URL.) */
export function HowItWorksContent() {
  return (
    <div className="howworks">
      <ol>
        <li>Deposit FXRP into the Torch vault on Flare. Your margin never leaves the chain.</li>
        <li>Open a long or short. The vault locks your margin and emits a request.</li>
        <li>
          An agent whose keys live inside a TEE mirrors your position on Hyperliquid's orderbook.
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
        off the operator's word is already live: Flare's Data Connector (Web2Json) proved a vault
        position's real Hyperliquid fill on-chain,{" "}
        <a
          href="https://coston2-explorer.flare.network/tx/0xb80330ba62544314a7f3d50ff22d0798258fecb56fcabf6d25a5b91a0e674d7d"
          target="_blank"
          rel="noreferrer"
        >
          verified by Flare's validators here
        </a>
        . Next: the executor ports onto Flare Confidential Compute as a Flare Confidential
        Extension — instructions submitted on-chain through a registered InstructionSender
        contract, results signed inside the TEE and accepted by Flare's data providers only from
        a code hash whitelisted on-chain — so no single operator can stall or drain it. Protocol
        Managed Wallets, still in development, are the eventual endgame.
      </p>
    </div>
  );
}
