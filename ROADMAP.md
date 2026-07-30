# Torch Roadmap

What's live, what's next, and what's proven — driven largely by real tester feedback across the Paper Perps League seasons. Honest status on each, same as everywhere else in this repo.

## Live now (Coston2 testnet)
- **Six markets** — XRP, BTC, ETH perps up to 10x, plus HYPE, SOL, DOGE (listed Jul 21 from live FTSOv2 feeds, requested by testers during Season 1)
- FXRP margin, every settlement bounded on-chain by FTSOv2 (reverts >1.5% off feed)
- Executor key sealed in an attested Intel TDX enclave (Phala), trade-only, no custody
- **Real trading charts** — multi-timeframe candles (real Hyperliquid mainnet history where the testnet feed tracks it, honestly labelled), EMA/SMA/Bollinger/RSI, trendline + horizontal drawing, entry and liquidation lines on your open positions *(shipped mid-Season 2 from league feedback)*
- Positions table with est. liquidation price and margin-health bar
- FDC (Web2Json) verification of real Hyperliquid fills, bound to vault positions
- Paper Perps League **Season 2** (Jul 22 – Aug 5, top 10 paid), Hall of Flame leaderboard, in-app feedback, mobile wallet connect
- Loop-health telemetry: the enclave status endpoint reports heartbeat age, cycle count, and a low-gas flag, so "idle" and "wedged" are distinguishable from outside

## Proven (Jul 29): one XRPL signature funds Torch margin
Flare Smart Accounts' custom-instruction flow reached TorchVault with **zero contract changes**: a plain XRPL testnet wallet signed a single ~10.3 XRP payment with a 42-byte memo, Flare's Data Connector attested it, and one Coston2 transaction atomically minted FXRP to the user's CREATE2-derived PersonalAccount, approved, and deposited **10 FXRP of trading margin** — no EVM wallet, no gas, no bridge. Receipts: [XRPL tx](https://testnet.xrpl.org/transactions/BE8301336DA71C7B488BDC0C1006051599E439D50FC2F492CB334659766B94F7) → [Coston2 execute tx](https://coston2-explorer.flare.network/tx/0xbaf5241608039406d307cdb46a6fcd1a55ad42b3fd31608bf077dd12b0298fee). Details + reproduce steps in [`spikes/fsa-one-signature-margin/`](spikes/fsa-one-signature-margin/README.md). The vault's smart-account cleanliness is locked in by test (`contracts/test/smartAccount.test.ts`). An XRPL-wallet funding UX built on this is a post-hackathon item; the rail itself is proven.

## Proven (Jul 22): the enclave trades the real book
The full differentiating loop has now run end-to-end from attested hardware: the enclave-held key placed and closed a **real Hyperliquid testnet order** (BTC, oids 56855249387 / 56855250250), and Flare's Data Connector independently re-fetched and verified that exact fill on-chain — [tx 0xe2798ac7…57c01](https://coston2-explorer.flare.network/tx/0xe2798ac7031802b535ec2a52f844a2c811021b496151ba21405ece9dc3257c01). The league loop still fills at the FTSO mark (deliberately, until the season ends); flipping production to real exchange execution is now a config change, not a research question.

## Next (dated)
- **Aug 6, after Season 2 settles — the v2 vault:**
  - **Stop-loss and take-profit orders** — the executor acts only on user-set triggers the contract re-verifies against FTSO on-chain, same pattern as liquidations. *(Most-requested tester feature of Season 1.)*
  - **Deposit and notional caps** — per-user and global, so payouts can never outrun the insurance fund silently.
  - Insurance-fund sweep + fresh seeding; owner escape hatches identified in the July audit.
- **Aug 6+, production flip to real Hyperliquid execution** (`EXECUTION_MODE=testnet`) on the proven node-22, digest-pinned image — never mid-league.
- **Partial-fill handling** and **FDC on every settlement** (not spot-checked) ride the v2 line.
- **Aug 7–11, stretch (only if v2 and the demo video land early): "Fund from your XRP wallet."** The guided version of the Jul 29 proof: the UI builds the Smart Accounts instruction, your XRPL wallet signs one payment (QR / Xaman), and the enclave agent runs the permissionless executor leg that lands margin on Flare. Design: [`spikes/fsa-one-signature-margin/FUNDING_FLOW.md`](spikes/fsa-one-signature-margin/FUNDING_FLOW.md). If the window closes, this moves to the top of post-hackathon work, not out of it.

## Horizon
- **Port the executor to a Flare Confidential Extension (FCE).** Per Flare-team guidance this replaces "wait for PMWs" as the decentralization path available now: the executor runs on Flare's own confidential-compute stack (approved for Songbird via STP.13, Jul 12 2026), its code hash pinned on-chain in the TeeExtensionRegistry, instructions signed by Flare's data providers. Reference: [flare-foundation/fce-orderbook](https://github.com/flare-foundation/fce-orderbook).
- **Mainnet pilot** with FXRP margin, tight caps, real Hyperliquid execution with a builder code attached.
- **Protocol Managed Wallets** remain the endgame once they ship (still in development): the executor role moves to the protocol quorum entirely. The vault contract does not change — it only ever knew an executor address.

---
*Testnet software. Not audited. Not investment advice. Roadmap items are intentions, not commitments or dates, except where dated above.*
