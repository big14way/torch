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

## Proven (Jul 22): the enclave trades the real book
The full differentiating loop has now run end-to-end from attested hardware: the enclave-held key placed and closed a **real Hyperliquid testnet order** (BTC, oids 56855249387 / 56855250250), and Flare's Data Connector independently re-fetched and verified that exact fill on-chain — [tx 0xe2798ac7…57c01](https://coston2-explorer.flare.network/tx/0xe2798ac7031802b535ec2a52f844a2c811021b496151ba21405ece9dc3257c01). The league loop still fills at the FTSO mark (deliberately, until the season ends); flipping production to real exchange execution is now a config change, not a research question.

## Next (dated)
- **Aug 6, after Season 2 settles — the v2 vault:**
  - **Stop-loss and take-profit orders** — the executor acts only on user-set triggers the contract re-verifies against FTSO on-chain, same pattern as liquidations. *(Most-requested tester feature of Season 1.)*
  - **Deposit and notional caps** — per-user and global, so payouts can never outrun the insurance fund silently.
  - Insurance-fund sweep + fresh seeding; owner escape hatches identified in the July audit.
- **Aug 6+, production flip to real Hyperliquid execution** (`EXECUTION_MODE=testnet`) on the proven node-22, digest-pinned image — never mid-league.
- **Partial-fill handling** and **FDC on every settlement** (not spot-checked) ride the v2 line.

## Horizon
- **Port the executor to a Flare Confidential Extension (FCE).** Per Flare-team guidance this replaces "wait for PMWs" as the decentralization path available now: the executor runs on Flare's own confidential-compute stack (approved for Songbird via STP.13, Jul 12 2026), its code hash pinned on-chain in the TeeExtensionRegistry, instructions signed by Flare's data providers. Reference: [flare-foundation/fce-orderbook](https://github.com/flare-foundation/fce-orderbook).
- **Mainnet pilot** with FXRP margin, tight caps, real Hyperliquid execution with a builder code attached.
- **Protocol Managed Wallets** remain the endgame once they ship (still in development): the executor role moves to the protocol quorum entirely. The vault contract does not change — it only ever knew an executor address.

---
*Testnet software. Not audited. Not investment advice. Roadmap items are intentions, not commitments or dates, except where dated above.*
