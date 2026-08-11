# Torch

Trade perps with your XRP. Margin stays on Flare, execution routes to Hyperliquid's orderbook (XRP itself fills at the FTSO mark until a venue lists it — see [current execution mode](#what-settles-where)), and the keys that bridge the two live inside a TEE.

**Live on Coston2 testnet: https://usetorch.xyz** (usetorch.vercel.app also works) — grab free C2FLR + FTestXRP from the [Flare faucet](https://faucet.flare.network), deposit, trade. Three minutes, costs nothing.

The XRP community holds one of the largest idle asset bases in crypto. FXRP-margined perps do already exist on Flare — [SparkDEX Eternal](https://flare.network/news/sparkdex-eternal-brings-perpetuals-to-flare) takes FXRP as collateral — so the gap Torch closes is not "can you trade with XRP" but **"can you check that the trade was honest."** Torch routes FXRP margin toward Hyperliquid's orderbook depth (live on venue-listed markets; XRP itself fills at the FTSO mark until a venue lists it) and makes each leg checkable: settlement bounded on-chain by Flare's enshrined FTSOv2 (the tx reverts if the price is off), the signing key sealed in an attested TEE that can settle but never withdraw, and exchange fills on venue-listed markets re-checkable on-chain by Flare's own validators through FDC — demonstrated on-chain for real fills, including the first live user-flow position. The operator's remaining discretion is bounded and named rather than hidden, and the [Verify page](https://usetorch.xyz/verify) publishes what is *not* proven alongside what is.

What's live, staged, and next: [ROADMAP.md](ROADMAP.md). At a glance, so no sentence below has to carry more weight than the evidence does:

| Piece | Status | Check it |
| --- | --- | --- |
| Coston2 vault + trading terminal | **Live** | https://usetorch.xyz + address table below |
| FTSOv2 price band on every settlement | **Live** | settlements revert outside 1.5% of the enshrined feed |
| TEE enclave signs fills, key never seen by anyone | **Live** | [enclave status endpoint](https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network) |
| Execution mode | **Live = `testnet`** (Aug 6): venue-listed markets route to Hyperliquid's real book; XRP fills at the FTSO mark | published by the enclave itself, rendered on [/verify](https://usetorch.xyz/verify) |
| Hyperliquid exchange routing | **Live** for venue-listed markets — first user-flow round trip Aug 6, oid `57497722789` | HL testnet info API, account in the Hyperliquid section |
| Per-fill FDC auto-attestation | **Live** (Aug 7): the enclave runs the Web2Json round trip itself and binds every venue fill to its position | tx receipts below |
| Stop-loss / take-profit | **Live** end to end (Aug 7): triggers set on-chain, the keeper fires only when the contract re-reads FTSO and agrees | set from the positions table |
| One-signature margin from a bare XRPL wallet | **Proven on-chain** (spike, not yet product UI) | XRPL + Coston2 receipts below |
| Hyperliquid builder-code revenue | **Wired, never exercised** | `HL_BUILDER_ADDRESS` in the adapter, unset today |
| Flare Confidential Compute (FCE) | **Live on Coston2** (Aug 11): extension 66154, `TORCH`/`ATTEST_FILL`, enclave-signed fills | [fce/](fce/README.md) + receipts there |
| Vault gated on the enclave signature | **Deployed, not yet wired** — adapter is inert until `setExecutor` | [TorchTeeExecutor](contracts/contracts/TorchTeeExecutor.sol) |
| PMW · FDC-gated settlement | **Planned** | [ROADMAP.md](ROADMAP.md) |

Built for the Flare Summer Signal hackathon, entering both bounties:

- Interoperable Asset Products: FXRP margin on Flare with a hedge leg routing live to external Hyperliquid liquidity (venue-listed markets; XRP falls back to the FTSO mark)
- Confidential Compute Apps: a TEE-held executor key with a no-withdrawal exchange wallet — **now joined by a Flare Compute Extension running on Flare's own confidential-compute stack** (Coston2, extension 66154), which fetches a position's Hyperliquid fill from inside the enclave and signs it for on-chain verification; Protocol Managed Wallets are the later endgame once they ship

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

**Hyperliquid is where the house hedges.** When you go long, the vault is your counterparty; unhedged, the insurance fund carries every trader's PnL. The executor mirrors venue-listed positions onto Hyperliquid's book to keep the operator's exposure flat (XRP, unlisted there, stays unhedged and insurance-carried for now) — the hedge earns what traders win, though moving that PnL back into the on-chain insurance fund is a manual operator step today, not an automatic bridge — and hedge fills settle in USDC on Hyperliquid because that is the operator's risk book, not yours.

**Current execution mode.** The deployed enclave runs `EXECUTION_MODE=testnet` (flipped Aug 6, after Season 2 closed): orders on venue-listed markets (BTC, ETH and others) are placed on Hyperliquid's testnet book from inside the enclave, and the on-chain confirm reports the user-favorable side of (venue fill, oracle) — venue-vs-oracle basis is carried by the operator's hedge book, never by the user. The first live user-flow round trip is position #1: real Hyperliquid oid `57497722789`, opened and settled through the vault the same morning. One honest limit: Hyperliquid's testnet lists no XRP market, so XRP fills at the FTSO mark with nothing to attest until a venue lists it. The live mode is published by the enclave's own status endpoint and rendered on the Verify page, so the site cannot quietly disagree with reality.

**FTSO is the glue between the legs.** The executor's reported fill must sit within 1.5% of the live FTSO feed or the contract reverts, which both stops the operator from inventing prices and forces the hedge leg to stay coherent with the Flare settlement price. Any drift between the venues inside that band is basis risk carried by the operator, never by the user. FDC can then prove after the fact that a fill with the order id the vault recorded really exists on Hyperliquid with the right market and side — every venue-routed fill now stores a real exchange order id; XRP's FTSO-mark fills carry none (price and size are not equivalence-checked; see the trust model below).

In short: Flare is the market, FTSO is the settlement judge, FDC is the audit, and Hyperliquid is borrowed liquidity. (Since Aug 6 the deployed enclave routes venue-listed markets to Hyperliquid's testnet book — the first live round trip and its FDC receipts are in the deployment section below; XRP itself fills at the FTSO mark until a venue lists it.)

## How Torch makes money

Two rails, both already in the code, stated with the same honesty as everything else:

1. **Vault fees, live on-chain today.** The vault charges **8 bps on open, 8 bps on close** (0.08% of notional each way) plus **100 bps on liquidations**, paid in FXRP — see `openFeeBps` / `closeFeeBps` / `liquidationFeeBps` in [TorchVaultV2.sol](contracts/contracts/TorchVaultV2.sol). Precisely: the live v2 vault routes open, close, and liquidation fees to the treasury in every case (the retired v1 sent close/liquidation fees there only on losing closes; on wins they accrued to insurance). This is the primary revenue line, and it scales with exactly one thing: FXRP margin volume. Torch's revenue metric *is* Flare's FXRP-adoption metric.

2. **Hyperliquid builder codes, wired into the adapter.** Orders the executor routes carry a builder tag when `HL_BUILDER_ADDRESS` is set (fee in tenths of a bp, perp cap 10 bps) — Hyperliquid's native, on-chain revenue rail for order-flow routers, collected by the venue automatically per fill. Honest footnote: the address is unset in the live deployment and no builder-tagged order has ever been placed; and in the current architecture the only Hyperliquid flow is the operator's own hedge book, where a builder fee is circular. The rail earns real third-party revenue only as Torch's routing footprint grows beyond the house book (e.g. direct-account trading through the Torch terminal). It's wired now: turning it on is a config flag plus a one-time `approveBuilderFee`, not new code.

No token, no yield promises. Fees on real flow, denominated in the asset the community already holds.

## Trust model

Stated honestly. This is v0, a verifiable operator, not yet a trustless bridge:

1. Every price the executor reports is checked on-chain against Flare FTSOv2 and reverts if it sits outside a 1.5% band, so the operator cannot invent prices. Inside that band it still chooses, which is real discretion and worth naming: the live v2 vault additionally rejects any reported price *worse for the user* than the oracle and decides liquidation eligibility at a fresh oracle read (the retired v1 enforced the band alone).
2. The Hyperliquid key the agent holds is an API wallet, which can trade but can never withdraw. Compromising the agent does not give custody.
3. Positive PnL is paid from an explicit on-chain insurance fund, and payouts are capped at its live balance (`PayoutCapped`) — stated here rather than discovered at withdrawal. On testnet that balance is deliberately small and shrinks as winners draw on it (the /verify page shows the live figure), so treat it as the current ceiling on any single win; the order ticket warns before you size into a cap. Negative PnL accrues to the fund. Nothing is hidden in an off-chain promise.
4. What the FDC attestation does and does not prove: it proves Flare's validators independently re-fetched the exchange and found that the order id the vault recorded really exists in our account with the right market and side, with every request parameter pinned on-chain. It does **not** compare the fill's price, size or timestamp to the position, and it covers the **entry** fill only — the exit that sets your PnL carries no exchange order id, so it cannot be attested. The enclave now produces these receipts automatically for every venue-routed fill, but no vault code path reads them: they are receipts, not a gate on settlement. Both halves are stated on the [Verify page](https://usetorch.xyz/verify).
5. Stop-loss and take-profit are instructions to the executor, not guarantees. The contract re-reads FTSOv2 and refuses an uncrossed trigger, so the executor cannot fire one early — but only the executor can fire one at all, and a stalled agent means your stop does not fire (the two-hour self-close escape covers a close you have already requested, not an untouched trigger). A fired trigger settles at the oracle mark at that moment, not the price you typed: clamping to your exact number would make a position unclosable exactly when the stop matters most.
6. Roadmap: FDC Web2Json attestations of Hyperliquid fills replace bare executor reports, and the executor ports onto Flare Confidential Compute as a Flare Confidential Extension (instructions submitted on-chain through the extension's registered InstructionSender contract; results signed inside the TEE and accepted by Flare's data providers only from a code hash whitelisted on-chain — see [fce-orderbook](https://github.com/flare-foundation/fce-orderbook)). Protocol Managed Wallets, still in development, are the eventual endgame.

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
3. Long XRP at 5x with 500 margin. Watch the route trace light up Flare vault, then TEE agent, then the settlement mark as the fill confirms (the third hop is labelled Hyperliquid only when exchange routing is actually on).
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
| TorchVaultV2 (live, Aug 6) | [`0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd`](https://coston2-explorer.flare.network/address/0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd#code) (source-verified) |
| FtsoV2Reader (registry-resolving, live) | [`0xF8be9ca7bCb07B0e87BDcEAB28841fF6A16E7D01`](https://coston2-explorer.flare.network/address/0xF8be9ca7bCb07B0e87BDcEAB28841fF6A16E7D01#code) (source-verified) |
| FXRP (FTestXRP) | [`0x0b6A3645c240605887a5532109323A3E12273dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |
| TorchFdcConsumer (bound to v2) | [`0xe3B21cbD82dcc4acD4BFDAC5Ee61AC1E2B9F2a6f`](https://coston2-explorer.flare.network/address/0xe3B21cbD82dcc4acD4BFDAC5Ee61AC1E2B9F2a6f#code) (source-verified) |
| TorchVault v1 (Jul 15 – Aug 6, retired: 28 depositors, 26 traders, 221 positions) | [`0x7fC640Bd0e635a6AFc3B437e80f0DE192f6FA0BA`](https://coston2-explorer.flare.network/address/0x7fC640Bd0e635a6AFc3B437e80f0DE192f6FA0BA) |
| TorchFdcConsumer v1 (retired with v1; holds the July attestations) | [`0x581B822B34bEf5138f2CE6EaCE81384D553F70a8`](https://coston2-explorer.flare.network/address/0x581B822B34bEf5138f2CE6EaCE81384D553F70a8#code) (verified) |

v1 is retired, not erased: its full trading history stays on-chain at that address, its executor now points at an owner-controlled fallback so the remaining open positions can still settle, and its insurance fund stays in place backing them.

Markets XRP, BTC, ETH, HYPE, SOL and DOGE are listed at up to 10x — all six at v2 deploy, feed ids byte-checked against the live feed list — and every executor price is bounded live by the enshrined FtsoV2 (verified on-chain after deploy: the vault reads real FTSO marks on all six feeds, normalized to 6 decimals).

**Confidential executor (Phala TDX enclave, attested):**

The executor key is generated *inside* a hardware TEE (Phala Cloud, Intel TDX) and never leaves it. The running image and its config are bound by a remote-attestation report, and the enclave signs `confirmFill` from a key no operator has ever seen. The vault's `executor` was pointed at the enclave-generated address via `setExecutor` (owner-only, no redeploy).

- Live status endpoint (returns the current executor address + attestation mode): https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network
- App id `cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a`. The compose hash and TDX measurement rotate on every CVM update, so read the current values from the CVM's attestation report rather than from numbers frozen in a README; the compose file pins the executor image by digest so the attestation binds exact code, not a mutable tag (live since the Aug 6 deploy).

In this deployment the enclave routes venue-listed markets to Hyperliquid's testnet book and fills XRP at the FTSO mark (no XRP market there). Venue-routed fills store real exchange order ids and are FDC-attestable; FTSO-mark fills are not. Migration target: a Flare Confidential Extension on FCC (Songbird), with Protocol Managed Wallets as the eventual endgame.

**FDC Web2Json fill attestation (the path off trusted reports):**

The endgame of the trust model is that a fill is not believed because our executor reported it, but because Flare's own validators re-fetched Hyperliquid and agreed. That has run on-chain — proven for real exchange fills and bound to a real position; since the Aug 6 flip every venue-routed fill stores an attestable order id, and per-fill automatic attestation is the next wiring step:

- **A vault position is bound to the exchange fill that backs it.** `attestFillForPosition(positionId, proof)` reads the Hyperliquid order id the vault stored at `confirmFill`, reconstructs the exact JQ transform for that order id on-chain, and only accepts an FDC proof whose request matches — with every degree of freedom pinned: URL, account body, HTTP method, headers, query params, JQ, and the ABI signature (a free signature would let components be reordered and fields transposed). The fill must also match the position's market and direction, and each fill can back at most one position. **Live on v2, bound by the enclave itself (Aug 7):** every venue-routed position is auto-attested — #1 ([`0x32cb4534…`](https://coston2-explorer.flare.network/tx/0x32cb45341a5fe466609a389029d93850b9a248872a6e4cc63b33b6966527b71a)), #3 ([`0xfb3a9222…`](https://coston2-explorer.flare.network/tx/0xfb3a92226ede6af25abe3264588c99ed00575698c65093cdd88b8d6980b57bd2) — an organic user's SHORT, and the fill that taught the direction check about Hyperliquid's netting labels: its hedge sell read "Close Long" against a net-long house book, so the consumer now pins the trade's buy/sell class rather than the label), and #7 ([`0x58b7cb49…`](https://coston2-explorer.flare.network/tx/0x58b7cb4955d71f823b3a89c8b46a8ed98ee3ae687247447c858fcb6104d9f649)). July, on v1: position #10 bound to Hyperliquid oid `55912729349` in tx [`0xb80330ba…674d7d`](https://coston2-explorer.flare.network/tx/0xb80330ba62544314a7f3d50ff22d0798258fecb56fcabf6d25a5b91a0e674d7d). What's proven: the order id the vault recorded exists in the executor account's real fill history with the right market and side; price/size are recorded in the event but not equivalence-checked (entries are FTSO-banded marks, testnet exchange prices legitimately drift).
- Standalone fill attestation (`attestFill`, latest fill, replay-guarded by order id): tx [`0xe6a22c2f…8878cd`](https://coston2-explorer.flare.network/tx/0xe6a22c2fe1618adcc50bd745e37c284e336045316a7ca8deaa59b3f2758878cd).
- **An enclave-executed fill, attested (Jul 22 2026):** a TDX CVM running this executor's exchange adapter placed and closed a real Hyperliquid testnet order *from inside the enclave*, and FDC verified that exact fill on-chain: tx [`0xe2798ac7…57c01`](https://coston2-explorer.flare.network/tx/0xe2798ac7031802b535ec2a52f844a2c811021b496151ba21405ece9dc3257c01). In-enclave execution, real orderbook, validator proof — the loop has run end to end. (Precisely: the Hyperliquid API key is operator-provisioned; the key no one has ever seen is the executor key that signs `confirmFill`.)
- The flow is scripted and permissionless: `npm run fdc:attest -w contracts` (latest fill) or `POSITION_ID=<id> npm run fdc:attest -w contracts` (position-bound) — prepare the request at the FDC verifier, submit to `FdcHub`, wait the voting round (~2-3 min), pull the Merkle proof from the DA layer, then the consumer verifies it through `ContractRegistry.getFdcVerification()`. Since Aug 7 this runs without an operator: the enclave attests every venue fill itself (see the receipts above; the manual script remains as anyone's independent check). The Aug 6 receipts — the canary close attested standalone (tx [`0x95764f39…c243`](https://coston2-explorer.flare.network/tx/0x95764f39d8768a7f037ec794eb3a1776f66b33969c4b8f65affc339ebf03c243)) and the first position binding — live on the day-one v2 consumer (`0xf8A5…cbff`), retired within a day when a real short taught the direction check about netting labels. One honest note: the consumer is replay-guarded, so re-running an already-attested target reverts — a from-scratch run needs a fresh exchange fill, which any venue-routed trade produces.
- Kept out of the `confirmFill` hot path on purpose: a round trip is ~2 min plus a fee, so requiring an inline proof on every fill would stall the live loop. Attestation is the after-the-fact audit path — any fill backed by a real exchange order id can be proven later, by anyone, without trusting us. The vault does not read the consumer yet: settlement still rides on executor-reported prices banded by FTSO, and wiring proofs into settlement is roadmap. (Mock-mode fills carry internal sequence ids and are not attestable; the FDC path applies to exchange-routed fills.)

**Flare Smart Accounts (Jul 29 2026): margin funded from a bare XRPL wallet.**

An XRPL testnet wallet signed **one** payment carrying a 42-byte memo; FDC attested it; one Coston2 transaction then atomically minted FXRP to the user's CREATE2-derived PersonalAccount, approved, and deposited 10 FXRP of margin into TorchVault. No EVM wallet, no gas held by the user, no bridge UI, zero vault changes — the vault is `msg.sender`-keyed with no EOA assumptions (locked in by `contracts/test/smartAccount.test.ts`). Receipts: [the XRPL signature](https://testnet.xrpl.org/transactions/BE8301336DA71C7B488BDC0C1006051599E439D50FC2F492CB334659766B94F7) → [the Coston2 execute tx](https://coston2-explorer.flare.network/tx/0xbaf5241608039406d307cdb46a6fcd1a55ad42b3fd31608bf077dd12b0298fee). Write-up and reproduce steps: [`spikes/fsa-one-signature-margin/`](spikes/fsa-one-signature-margin/README.md).

To reproduce the deployment from scratch:

1. Get C2FLR gas and testnet FXRP from the Coston2 faucet: https://faucet.flare.network
2. Copy `contracts/.env.example` to `contracts/.env`, set `PRIVATE_KEY` and `FXRP_ADDRESS` (the FXRP token address on Coston2, readable from your faucet tx on the Coston2 explorer).
3. FtsoV2 needs no configuration: the reader resolves it on-chain through the FlareContractRegistry on every read, so an FtsoV2 redeploy is picked up automatically. To sanity-check what the registry currently points at:

```bash
npm run resolve:ftso -w contracts
```

4. Set `EXECUTOR_ADDRESS` to the agent's address, then:

```bash
npm run deploy:coston2
```

5. Run the agent against Coston2 by setting in `agent/.env`: `RPC_URL=https://coston2-api.flare.network/ext/C/rpc` and `EXECUTOR_PRIVATE_KEY` to the executor key. Use `EXECUTION_MODE=mock` for a Flare-only loop, or `testnet` to route venue-listed markets to Hyperliquid (smoke-test egress first — the deployed enclave runs `testnet`).
6. `npm run web` now serves the Coston2 build automatically, because the web app reads `chainId` from the generated deployments file.

## Hyperliquid testnet mode

Set `EXECUTION_MODE=testnet` in `agent/.env`. Prerequisites, in order:

1. A Hyperliquid account that has made at least one mainnet deposit. The testnet faucet gates on this.
2. Claim 1,000 mock USDC: https://app.hyperliquid-testnet.xyz/drip
3. Create an API wallet on testnet (API wallets can trade, never withdraw): https://app.hyperliquid-testnet.xyz/API
4. Put the API wallet key in `agent/.env` as `HL_PRIVATE_KEY`.

The adapter uses the community SDK `@nktkas/hyperliquid` (verified against 0.15.4: `WalletClient`, `HttpTransport({ url: { api } })`, viem account as signer). Reads go through the public `/info` endpoint.

The adapter is proven against the live testnet: real BTC fills placed and closed through this code path on the demo account `0xfDb941fe97e13B599BC576c4142128aB97D01622` — check it yourself with a `userFills` query against the public `/info` endpoint. The July proving runs (including two fills executed *from inside the TDX enclave*) are there alongside the live v2 fills that started Aug 6, with per-asset lot rounding and the $10 minimum-notional guard exercised. Two of those fills are FDC-attested on-chain (see the Coston2 section above).

One honest gap: Hyperliquid testnet does not list XRP. In testnet mode BTC, ETH and other venue-listed markets route to the real book; XRP — the flagship market — fills at the FTSO mark with `oid 0` (see the fallback in `agent/src/exchange.ts`), so XRP fills cannot be FDC-attested until a venue lists the pair. The web app's Honesty card states the same.

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

Not audited. Testnet software. The vault re-verifies liquidation conditions on-chain, bounds every executor price with FTSOv2, floors payouts at zero, and caps profit payouts at the insurance fund balance. Known open items for production: funding rates, partial closes, multi-executor quorum, withdrawal timelocks, and FDC-gated settlement (attestation itself is proven; wiring it into settlement is the open item).

## License

MIT
