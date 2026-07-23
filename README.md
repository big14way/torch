# Torch

Trade perps with your XRP. Margin stays on Flare, execution happens on Hyperliquid's orderbook, and the keys that bridge the two live inside a TEE.

**Live on Coston2 testnet: https://usetorch.vercel.app** — grab free C2FLR + FTestXRP from the [Flare faucet](https://faucet.flare.network), deposit, trade. Three minutes, costs nothing.

What's live, staged, and next: [ROADMAP.md](ROADMAP.md).

Built for the Flare Summer Signal hackathon, entering both bounties:

- Interoperable Asset Products: FXRP margin on Flare routed to external Hyperliquid liquidity
- Confidential Compute Apps: a TEE-held executor key with a no-withdrawal exchange wallet, migrating onto Flare Confidential Compute as a Flare Confidential Extension (FCE); Protocol Managed Wallets are the later endgame once they ship

The XRP community holds one of the largest idle asset bases in crypto, and today there is no way to use XRP itself as perps margin on a deep orderbook. Hyperliquid margins in USDC only. Torch closes that gap: FXRP in, Hyperliquid depth out, settlement bounded by Flare's enshrined FTSOv2 oracle.

## How it works

```
  You                      Flare (TorchVault)                TEE agent              Hyperliquid
   |  deposit FXRP  ---->   margin credited                      |                       |
   |  open 5x long  ---->   margin locked, request emitted ----> |  place order  ---->   |  fill
   |                        confirmFill(price, oid) <----------- |  <----------------    |
   |                        price must sit inside the            |                       |
   |                        FTSOv2 deviation band (1.5%)         |                       |
   |  close        ---->    CloseRequested ------------------->  |  unwind  --------->   |
   |  withdraw     <----    PnL settled in FXRP <--------------- |  <----------------    |
```

## What settles where

The question everyone asks: if Hyperliquid settles trades on its own book, what is Flare doing? The answer is that Torch has two legs, settling in two different places for two different parties.

**The user's trade settles on Flare. Always.** You deposit FXRP into the vault and trade against it: entry, exit, PnL, and liquidations are computed and settled by the TorchVault contract on Flare, in FXRP, priced against FTSOv2. You never hold a Hyperliquid account, never touch USDC, never leave Flare. Torch rebuilds the whole market structure on Flare — request, fill, close, liquidate, margin, maintenance, insurance — everything except the orderbook.

**Hyperliquid is where the house hedges.** When you go long, the vault is your counterparty; unhedged, the insurance fund would carry every trader's PnL. So the executor mirrors positions onto Hyperliquid's book to keep the operator's exposure flat — trader wins are recouped from the hedge, and the hedge fills settle in USDC on Hyperliquid because that is the operator's risk book, not yours.

**FTSO is the glue between the legs.** The executor's reported fill must sit within 1.5% of the live FTSO feed or the contract reverts, which both stops the operator from inventing prices and forces the hedge leg to stay coherent with the Flare settlement price. Any drift between the venues inside that band is basis risk carried by the operator, never by the user. FDC then proves after the fact that the hedge fills really happened on Hyperliquid, bound to the exact position.

In short: Flare is the market, FTSO is the settlement judge, FDC is the audit, and Hyperliquid is borrowed liquidity. (In the current Coston2 deployment the enclave fills at the FTSO mark itself, so today the live loop runs entirely on Flare; the Hyperliquid hedge leg is proven separately on testnet and slots in when the enclave gains exchange egress.)

## How Torch makes money

Two rails, both already in the code, stated with the same honesty as everything else:

1. **Vault fees, live on-chain today.** The vault charges **8 bps on open, 8 bps on close** (0.08% of notional each way) plus **100 bps on liquidations**, paid in FXRP straight to the treasury address — see `openFeeBps` / `closeFeeBps` / `liquidationFeeBps` in [TorchVault.sol](contracts/contracts/TorchVault.sol). This is the primary revenue line, and it scales with exactly one thing: FXRP margin volume. Torch's revenue metric *is* Flare's FXRP-adoption metric.

2. **Hyperliquid builder codes, wired into the adapter.** Every order the executor routes carries a builder tag (`HL_BUILDER_ADDRESS`, fee in tenths of a bp, perp cap 10 bps) — Hyperliquid's native, on-chain revenue rail for order-flow routers, collected by the venue automatically per fill. Honest footnote: in the current architecture the only Hyperliquid flow is the operator's own hedge book, where a builder fee is circular; this rail earns real third-party revenue as Torch's routing footprint grows beyond the house book (e.g. direct-account trading through the Torch terminal). It's wired now so the rail is proven, not theoretical.

No token, no yield promises. Fees on real flow, denominated in the asset the community already holds.

## Trust model

Stated honestly. This is v0, a verifiable operator, not yet a trustless bridge:

1. Every price the executor reports is checked on-chain against Flare FTSOv2 and reverts if it sits outside a 1.5% band. The operator cannot invent prices.
2. The Hyperliquid key the agent holds is an API wallet, which can trade but can never withdraw. Compromising the agent does not give custody.
3. Positive PnL is paid from an explicit on-chain insurance fund. Negative PnL accrues to it. Nothing is hidden in an off-chain promise.
4. Roadmap: FDC Web2Json attestations of Hyperliquid fills replace bare executor reports, and the executor ports onto Flare Confidential Compute as a Flare Confidential Extension (code hash pinned on-chain, instructions signed by Flare's data providers — see [fce-orderbook](https://github.com/flare-foundation/fce-orderbook)). Protocol Managed Wallets, still in development, are the eventual endgame.

## Repo layout

```
torch/
  contracts/   Hardhat project: TorchVault, TorchFdcConsumer, mocks, FtsoV2Reader, deploy + FDC scripts
  agent/       TypeScript executor: watches the vault, fills on the exchange, liquidates
  web/         Vite + React trading terminal (wagmi v2, viem, lightweight-charts)
```

## Run it locally, end to end

Requirements: Node 22 or newer (the Hyperliquid SDK needs the global `WebSocket`, which Node ships from 22; mock-mode-only runs work on 20), npm 10 or newer, MetaMask (or any injected wallet).

```bash
npm install
```

Terminal A, the chain:

```bash
npm run chain
```

Terminal B, deploy and start the agent:

```bash
npm run deploy:local
npm run agent
```

The deploy script writes contract addresses and ABIs into `web/src/generated` and `agent/src/generated`, deploys mock FXRP and a mock FTSOv2, lists XRP, BTC and ETH markets at up to 10x, and pre-funds a 50,000 tFXRP insurance pool. The agent starts in mock mode: it fills at the FTSO mark and random-walks the mock oracle so the demo moves on its own.

Terminal C, the web app:

```bash
npm run web
```

Open http://localhost:5173

MetaMask setup, one time:

1. Add a network manually: RPC `http://127.0.0.1:8545`, chain id `31337`, currency ETH.
2. Import the Hardhat test account #0 so you have gas: private key `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` (public, throwaway, never use on a real network).
3. If you restart the chain later, clear activity data for that account in MetaMask settings so the nonce resets.

Then in the app:

1. Connect wallet, hit `Faucet: 10,000 tFXRP`.
2. Deposit 2,000.
3. Long XRP at 5x with 500 margin. Watch the route trace light up Flare vault, then TEE agent, then Hyperliquid as the fill confirms.
4. Let the price walker move the market, watch live PnL tick.
5. Close, watch settlement land back in free margin, withdraw.
6. Optional: open a 10x position and wait. The walker will eventually push it below maintenance margin and you will see the agent liquidate it.

Scripted proof of the same journey (chain and agent must be running):

```bash
npm run smoke -w contracts
```

## Deploy to Coston2 (Flare testnet)

**Live on Coston2 (chain id 114):**

| Contract | Address |
| --- | --- |
| TorchVault | [`0x7fC640Bd0e635a6AFc3B437e80f0DE192f6FA0BA`](https://coston2-explorer.flare.network/address/0x7fC640Bd0e635a6AFc3B437e80f0DE192f6FA0BA) |
| FtsoV2Reader | [`0xe98BEc67F44993c3a9f479500a23f26ca05BcFc5`](https://coston2-explorer.flare.network/address/0xe98BEc67F44993c3a9f479500a23f26ca05BcFc5) |
| FXRP (FTestXRP) | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |
| TorchFdcConsumer | [`0x581B822B34bEf5138f2CE6EaCE81384D553F70a8`](https://coston2-explorer.flare.network/address/0x581B822B34bEf5138f2CE6EaCE81384D553F70a8#code) (verified) |

Markets XRP, BTC, ETH, HYPE, SOL and DOGE are listed at up to 10x (the last three added Jul 21 2026 by owner `listMarket`, feeds verified live first), every executor price bounded live by the enshrined FtsoV2 (verified on-chain after deploy: the vault reads real FTSO marks, normalized to 6 decimals).

**Confidential executor (Phala TDX enclave, attested):**

The executor key is generated *inside* a hardware TEE (Phala Cloud, Intel TDX) and never leaves it. The running image and its config are bound by a remote-attestation report, and the enclave signs `confirmFill` from a key no operator has ever seen. The vault's `executor` was pointed at the enclave-generated address via `setExecutor` (owner-only, no redeploy).

- Live status endpoint (returns the current executor address + attestation mode): https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network
- App id `cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a`, compose hash `3b1e6ed0f43a59df4b0a2028701106c24a4363f680b92be7bdf851b9c9bac332`, aggregated measurement `b33eb22ae8eed320d1ded19532519296c2d60931b5d9f64e5de34a5b9a70e800` (bound by TDX).

In this deployment the enclave fills at the FTSO mark; the live Hyperliquid hop (proven separately on testnet) routes when the TEE is granted outbound access to the exchange. In mock mode the stored `hlOid` is an internal sequence number, not an exchange order id — only exchange-routed fills can be FDC-attested. Migration target: a Flare Confidential Extension on FCC (Songbird), with Protocol Managed Wallets as the eventual endgame.

**FDC Web2Json fill attestation (the path off trusted reports):**

The endgame of the trust model is that a fill is not believed because our executor reported it, but because Flare's own validators re-fetched Hyperliquid and agreed. That is live, and it is bound to real positions:

- **A vault position is bound to the exchange fill that backs it.** `attestFillForPosition(positionId, proof)` reads the Hyperliquid order id the vault stored at `confirmFill`, reconstructs the exact JQ transform for that order id on-chain, and only accepts an FDC proof whose request matches — with every degree of freedom pinned: URL, account body, HTTP method, headers, query params, JQ, and the ABI signature (a free signature would let components be reordered and fields transposed). The fill must also match the position's market and direction, and each fill can back at most one position. Live: vault position #10 bound to Hyperliquid oid `55912729349` in tx [`0xb80330ba…674d7d`](https://coston2-explorer.flare.network/tx/0xb80330ba62544314a7f3d50ff22d0798258fecb56fcabf6d25a5b91a0e674d7d). What's proven: the order id the vault recorded exists in the executor account's real fill history with the right market and side; price/size are recorded in the event but not equivalence-checked (entries are FTSO-banded marks, testnet exchange prices legitimately drift).
- Standalone fill attestation (`attestFill`, latest fill, replay-guarded by order id): tx [`0xe6a22c2f…8878cd`](https://coston2-explorer.flare.network/tx/0xe6a22c2fe1618adcc50bd745e37c284e336045316a7ca8deaa59b3f2758878cd).
- **An enclave-executed fill, attested (Jul 22 2026):** the TEE-held key placed and closed a real Hyperliquid testnet order *from inside the enclave*, and FDC verified that exact fill on-chain: tx [`0xe2798ac7…57c01`](https://coston2-explorer.flare.network/tx/0xe2798ac7031802b535ec2a52f844a2c811021b496151ba21405ece9dc3257c01). The whole trust chain — sealed key, real orderbook, validator proof — has run as one loop.
- Anyone can reproduce either: `npm run fdc:attest -w contracts` (latest fill) or `POSITION_ID=10 npm run fdc:attest -w contracts` (position-bound). The flow: prepare the request at the FDC verifier, submit to `FdcHub`, wait the voting round (~2-3 min), pull the Merkle proof from the DA layer, then the consumer verifies it through `ContractRegistry.getFdcVerification()`.
- Kept out of the `confirmFill` hot path on purpose: a round trip is ~2 min plus a fee, so requiring an inline proof on every fill would stall the live loop. Attestation is the settlement-verification path — any fill backed by a real exchange order id can be proven after the fact, by anyone, without trusting us. (Mock-mode fills carry internal sequence ids and are not attestable; the FDC path applies to exchange-routed fills.)

To reproduce the deployment from scratch:

1. Get C2FLR gas and testnet FXRP from the Coston2 faucet: https://faucet.flare.network
2. Copy `contracts/.env.example` to `contracts/.env`, set `PRIVATE_KEY` and `FXRP_ADDRESS` (the FXRP token address on Coston2, readable from your faucet tx on the Coston2 explorer).
3. Resolve the live FtsoV2 address dynamically, never hardcode it:

```bash
npm run resolve:ftso -w contracts
```

4. Put the printed address in `.env` as `FTSOV2_ADDRESS`, set `EXECUTOR_ADDRESS` to the agent's address, then:

```bash
npm run deploy:coston2
```

5. Run the agent against Coston2 by setting in `agent/.env`: `RPC_URL=https://coston2-api.flare.network/ext/C/rpc` and `EXECUTOR_PRIVATE_KEY` to the executor key. Keep `EXECUTION_MODE=mock` until Hyperliquid testnet mode is smoke-tested.
6. `npm run web` now serves the Coston2 build automatically, because the web app reads `chainId` from the generated deployments file.

## Hyperliquid testnet mode

Set `EXECUTION_MODE=testnet` in `agent/.env`. Prerequisites, in order:

1. A Hyperliquid account that has made at least one mainnet deposit. The testnet faucet gates on this.
2. Claim 1,000 mock USDC: https://app.hyperliquid-testnet.xyz/drip
3. Create an API wallet on testnet (API wallets can trade, never withdraw): https://app.hyperliquid-testnet.xyz/API
4. Put the API wallet key in `agent/.env` as `HL_PRIVATE_KEY`.

The adapter uses the community SDK `@nktkas/hyperliquid` (verified against 0.15.4: `WalletClient`, `HttpTransport({ url: { api } })`, viem account as signer). Reads go through the public `/info` endpoint.

The adapter has been proven against the live testnet: real BTC and ETH fills placed and closed through this code path (20 fills on the demo account — the two most recent executed *from inside the TDX enclave*), with per-asset lot rounding and the $10 minimum-notional guard exercised. Two of those fills are FDC-attested on-chain (see the Coston2 section above).

## Assumptions, flagged then verified

Every launch assumption was written down before deploying and checked live. Status of each:

1. ✅ FtsoV2Reader's view-style `getFeedById` works with zero fees on Coston2 — verified with a live pre-deploy read probe, and every position since settles against it.
2. ✅ Feed ids for XRP/USD, BTC/USD, ETH/USD (bytes21 scheme) — match the live feed list at https://dev.flare.network/ftso/feeds
3. ✅ The FlareContractRegistry address in `resolveFtsoV2.ts` resolved the live FtsoV2 on Coston2.
4. ✅ Hyperliquid testnet faucet gating — handled with a small mainnet deposit in week 1.
5. ✅ Hyperliquid order placement — proven with real open/close round trips on testnet (signing, lot rounding, IOC semantics all exercised).
6. ✅ FDC Web2Json on Coston2 — live and working: a real Hyperliquid fill attested on-chain (verify tx in the Coston2 section above).
7. ✅ Real FXRP (FTestXRP) has 6 decimals — confirmed on the Coston2 token contract before pointing the vault at it.

## Security notes

Not audited. Testnet software. The vault re-verifies liquidation conditions on-chain, bounds every executor price with FTSOv2, floors payouts at zero, and caps profit payouts at the insurance fund balance. Known open items for production: funding rates, partial closes, multi-executor quorum, withdrawal timelocks, and the FDC attestation path.

## License

MIT
