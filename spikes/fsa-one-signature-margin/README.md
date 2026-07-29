# Spike: one XRPL signature → FXRP margin in TorchVault

**Proven Jul 29, 2026 on Coston2 + XRPL Testnet.** A plain XRPL wallet — no EVM wallet, no C2FLR, no bridge UI — funded a Torch margin account with a single signature, via Flare Smart Accounts' custom-instruction flow.

## What happened

1. A fresh XRPL testnet wallet (`r9FikWzMChyKfUMEhG2RKvqVgAc8xgxFQj`) signed **one** Payment of ~10.3 XRP to the FAssets Core Vault (`rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p`) carrying a 42-byte memo: `[0xFE][walletId][executorFee][keccak256(userOp)]`.
   - XRPL tx: [BE8301336DA71C7B488BDC0C1006051599E439D50FC2F492CB334659766B94F7](https://testnet.xrpl.org/transactions/BE8301336DA71C7B488BDC0C1006051599E439D50FC2F492CB334659766B94F7)
2. The userOp (hash committed in the memo, bytes delivered by the executor) batches two calls executed **by the user's PersonalAccount**: `FXRP.approve(TorchVault, 10e6)` then `TorchVault.deposit(10e6)`.
3. An FDC XRPPayment attestation (voting round **1409837**) proved the XRPL payment on Flare.
4. **One Coston2 transaction** then did everything atomically — minted 10.1 FXRP, credited the PersonalAccount (`0x2F57E98B9eA77175837e1611F057a0da96f3a689`, CREATE2-derived from the r-address, lazily deployed in this same tx), approved, and deposited 10 FXRP of margin:
   - [0xbaf5241608039406d307cdb46a6fcd1a55ad42b3fd31608bf077dd12b0298fee](https://coston2-explorer.flare.network/tx/0xbaf5241608039406d307cdb46a6fcd1a55ad42b3fd31608bf077dd12b0298fee)
   - Token transfers inside that one tx: mint → controller → PersonalAccount (10.1 FXRP) → TorchVault (10 FXRP)
5. End state, checkable now: `TorchVault.freeMargin(0x2F57E98B…a689) = 10 FXRP`.

If any inner call had reverted, the whole thing — including the mint — would have rolled back. Authorization is the FDC-attested XRPL source address; no signature field is checked, no key ever existed on the EVM side.

## Why it matters for Torch

Flare Smart Accounts is the onboarding rail ("XRPFi with one signature"); Torch is a destination that rail can feed. FSA's action latency is FDC-bound (~2–5 min), which is wrong for tick-level trading but exactly right for **funding and withdrawing margin** — the fast part is Torch's TEE agent. The vault needed **zero changes**: it is `msg.sender`-keyed with no EOA assumptions (verified in `contracts/test/smartAccount.test.ts`).

Honest boundaries: this is a technical demo driven by [flare-viem-starter](https://github.com/flare-foundation/flare-viem-starter) scripts, not a consumer flow — Flare hosts no Coston2 FSA frontend and Torch has not built an XRPL-wallet UX. "Integrated with FSA" would be an overclaim; "reachable from a bare XRPL wallet, demonstrated on-chain" is the exact truth.

## Reproduce

```bash
git clone https://github.com/flare-foundation/flare-viem-starter && cd flare-viem-starter
npm install --legacy-peer-deps && npm i react react-dom @tanstack/query-core @tanstack/react-query --legacy-peer-deps
cp .env.example .env   # set PRIVATE_KEY (Coston2 EOA with ~1 C2FLR, acts as executor)
curl -s -X POST https://faucet.altnet.rippletest.net/accounts -d '{}'   # → set XRPL_SEED
mkdir -p src/torch && cp <this dir>/mint-and-deposit.ts src/torch/
npm run script src/torch/mint-and-deposit.ts   # ~5–10 min end to end
```

The script is the executor too: it requests the FDC attestation, fetches the proof from the DA layer, and submits `executeDirectMintingWithData` — the permissionless surface, no Flare registration involved.
