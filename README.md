# Torch

Trade perps with your XRP. Margin stays on Flare, execution happens on Hyperliquid's orderbook, and the keys that bridge the two live inside a TEE.

Built for the Flare Summer Signal hackathon, entering both bounties:

- Interoperable Asset Products: FXRP margin on Flare routed to external Hyperliquid liquidity
- Confidential Compute Apps: a TEE-held executor key with a no-withdrawal exchange wallet, migrating to Flare Protocol Managed Wallets when FCC ships

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

Trust model, stated honestly. This is v0, a verifiable operator, not yet a trustless bridge:

1. Every price the executor reports is checked on-chain against Flare FTSOv2 and reverts if it sits outside a 1.5% band. The operator cannot invent prices.
2. The Hyperliquid key the agent holds is an API wallet, which can trade but can never withdraw. Compromising the agent does not give custody.
3. Positive PnL is paid from an explicit on-chain insurance fund. Negative PnL accrues to it. Nothing is hidden in an off-chain promise.
4. Roadmap: FDC Web2Json attestations of Hyperliquid fills replace bare executor reports, and the executor role migrates to Flare Protocol Managed Wallets (a protocol-run quorum of TEEs) when Flare Confidential Compute ships on Songbird.

## Repo layout

```
torch/
  contracts/   Hardhat project: TorchVault, mocks, FtsoV2Reader, deploy + smoke scripts
  agent/       TypeScript executor: watches the vault, fills on the exchange, liquidates
  web/         Vite + React trading terminal (wagmi v2, viem, lightweight-charts)
  BUILD.md     week-by-week plan to the Aug 14 deadline
  DESIGN.md    the full UI/UX system
  TRACTION.md  X strategy, ready-to-post threads, Paper Perps League plan
  ULTIMATE_PROMPT.md  one prompt that rebuilds or extends the whole project
  DEMO_SCRIPT.md      3 minute demo video script
```

## Run it locally, end to end

Requirements: Node 20 or newer, npm 10 or newer, MetaMask (or any injected wallet).

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

Important: this sandbox-built adapter has not been fired against the live testnet yet. Smoke-test one open and one close manually before any demo. Tick and lot size rounding per asset is the most likely thing to need a fix.

## Assumptions to verify before submission

These are flagged, not hidden:

1. FtsoV2Reader assumes the view-style `getFeedById` works with zero fees on Coston2 (the TestFtsoV2Interface pattern from Flare docs). Verify with one live read after deploy.
2. Feed ids for XRP/USD, BTC/USD, ETH/USD are constructed per the documented bytes21 scheme. Verify against the live feed list at https://dev.flare.network/ftso/feeds
3. The FlareContractRegistry address in `resolveFtsoV2.ts` is the documented canonical one. The script itself is the verification: if it resolves FtsoV2, it is right.
4. Hyperliquid testnet faucet requires a prior mainnet deposit from the same address. Budget a small mainnet deposit early in week 1.
5. Hyperliquid order placement (signing, tick rounding, IOC semantics) must be proven with one live round trip on testnet.
6. FDC Web2Json availability and exact request shape on Coston2 should be re-checked the week you wire it (roadmap item, not in this MVP).
7. Real FXRP has 6 decimals like the mock. Confirm on the Coston2 token contract before pointing the vault at it.

## Security notes

Not audited. Testnet software. The vault re-verifies liquidation conditions on-chain, bounds every executor price with FTSOv2, floors payouts at zero, and caps profit payouts at the insurance fund balance. Known open items for production: funding rates, partial closes, multi-executor quorum, withdrawal timelocks, and the FDC attestation path.

## License

MIT
