# Torch Roadmap

What's live, what's staged, and what's next — driven largely by real feedback during the Paper Perps League. Honest status on each, same as everywhere else in this repo.

## Live now (Coston2 testnet)
- XRP, BTC, ETH perps up to 10x, FXRP margin
- Every settlement price bounded on-chain by FTSOv2 (reverts >1.5% off feed)
- Executor key sealed in an attested Intel TDX enclave (Phala), trade-only, no custody
- FDC (Web2Json) verification of a real Hyperliquid fill, bound to the vault position
- Live vault stats, Hall of Flame leaderboard, in-app feedback, mobile wallet connect (WalletConnect + MetaMask deep link)

## Staged — built, waiting on the next deploy window
These are done in code; they list/ship the next time the enclave is upgraded (so the live league is never interrupted mid-run).
- **More markets: HYPE, SOL, DOGE.** All three have live FTSOv2 feeds on Coston2; the agent and listing script are ready. New markets are config, not a redeploy — an FTSO feed plus a Hyperliquid mapping. *(Requested by testers during the league.)*
- **Hyperliquid builder-code revenue rail** wired into the executor, earns on routed flow beyond the house hedge book.
- **Agent robustness**: single-fire liquidations, unwind of an exchange fill if the on-chain confirm reverts, live maintenance-margin read.

## Next (needs a contract change — v2 vault)
- **Stop-loss and take-profit orders.** A stop trigger the executor can act on doesn't exist in v1's permissions; it comes with the v2 vault. *(Requested by testers during the league.)*
- **Deposit and global caps** for a safe mainnet pilot (per-user cap, global cap, conservative max leverage).
- **Partial-fill handling** — v1 is all-or-nothing; v2 splits partials on the exchange side.
- **FDC on every settlement**, not spot-checked — each fill provably bound on-chain.

## Horizon
- **Port the executor to a Flare Confidential Extension (FCE).** After guidance from the Flare team, this replaces "wait for PMWs" as the decentralization path available now: the executor runs on Flare's own confidential-compute stack, its code hash pinned on-chain in the TeeExtensionRegistry, instructions signed by Flare's data providers, and the signing key backed across providers so no single operator (including us) can stall or drain it. Reference: [flare-foundation/fce-orderbook](https://github.com/flare-foundation/fce-orderbook).
- **Mainnet pilot** with FXRP margin, tight caps, real Hyperliquid execution with a builder code attached.
- **Protocol Managed Wallets** remain the endgame once they ship: the executor role moves to the protocol quorum entirely. The vault contract does not change — it only ever knew an executor address.

---
*Testnet software. Not audited. Not investment advice. Roadmap items are intentions, not commitments or dates.*
