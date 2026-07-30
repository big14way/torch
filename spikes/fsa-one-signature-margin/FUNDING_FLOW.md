# Design: "Fund from your XRP wallet" (guided FSA funding flow)

Productizes the Jul 29 spike (see [README.md](README.md)). Scope: fund and withdraw
Torch margin from an XRPL wallet with one signature, guided by the UI, with the
enclave agent playing the permissionless executor. **Not** in scope: trading via
XRPL instructions (each action pays the ~2–5 min FDC toll — funding cadence, not
trading cadence), mainnet, redeeming FXRP back to XRPL.

Status: queued as the Aug 7–11 stretch, behind the v2 deploy and the demo video.
Estimate: 2–4 focused days.

## The three legs (all proven in the spike)

```
[web]   build instruction     — derive PA, read nonce, encode userOp, 42-byte 0xFE memo
[user]  sign one XRPL payment — QR / Xaman deep link to the Core Vault address
[agent] executor leg          — FDC proof → executeDirectMintingWithData → margin lands
```

## A. Web: the funding flow

Entry points: the "XRP Ledger wallet" option in the connect menu (already live as
watch mode) and the Account panel when watching.

1. **Build** (all in-browser, no signing): user enters amount →
   `getPersonalAccount(rAddress)` (have it in `watch.ts`) → `getNonce(PA)` on the
   MasterAccountController → calls `[FXRP.approve(vault, amt), vault.deposit(amt)]`
   → ABI-encode the PackedUserOperation (sender=PA, nonce, callData=
   `executeUserOp(Call[])`, everything else zero) → memo =
   `0xFE ‖ walletId=0 ‖ executorFeeUBA=0 (8B BE) ‖ keccak256(op)`.
2. **Payment request**: destination = `AssetManagerFXRP.directMintingPaymentAddress()`
   (read on-chain per session, never hardcoded; `rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p`
   on Coston2 today), amount = net mint + direct-minting fee (read from the
   AssetManager settings; ~0.2–0.35 XRP on Coston2). **No DestinationTag, ever.**
   Render: QR + copy fields (address / amount / memo hex). Xaman deep link if the
   format tests out early; plain copy+QR is the floor.
3. **Hand off to the agent**: POST `{rAddress, opBytes}` to the agent (the memo only
   carries the hash; the executor needs the bytes). Then the browser polls XRPL
   testnet JSON-RPC directly for the user's payment to the Core Vault whose memo
   matches `keccak256(opBytes)`, and POSTs the tx hash when seen — keeps XRPL
   watching out of the agent's loop.
4. **Status tracker**: poll agent status; render the honest pipeline —
   `signed → FDC round N voting → proven → landed on Flare (tx …) → margin credited`
   (~2–5 min total). Free-margin polling already refreshes the panel at the end.

## B. Agent: the executor module

New HTTP surface next to the existing status endpoint:

- `POST /fsa/intent {rAddress, opBytes}` → validates and stores (disk, TTL 24h,
  one open intent per PersonalAccount — avoids nonce races).
- `POST /fsa/seen {intentId, xrplTxHash}` → kicks execution.
- `GET  /fsa/status/{intentId}` → `{phase, votingRound?, flareTx?, error?}`.

**Validation is the security boundary.** The agent must never be a generic
executor. Accept an op only when ALL hold:
- `userOp.sender == getPersonalAccount(rAddress)` and nonce matches on-chain;
- `callData` decodes to `executeUserOp(Call[])` where every call is one of:
  `FXRP.approve(TorchVault, amt)`, `TorchVault.deposit(amt)`,
  `TorchVault.withdraw(amt)` — exact target addresses, nothing else;
- amounts under a per-op cap (config, start 1,000 FXRP);
- the XRPL tx (fetched from XRPL JSON-RPC) pays the Core Vault, is validated,
  and its memo hash equals `keccak256(opBytes)`.

Execution reuses the spike flow verbatim (prepareRequest → FdcHub.requestAttestation
→ DA proof → `executeDirectMintingWithData(proof, opBytes)`), paid from the enclave
key (it already holds gas; FDC fee is small — extend the existing `gas.low`
telemetry to cover it). Idempotent per XRPL tx (`usedTransactionIds` guards replay
on-chain; check it before submitting).

**Withdraw variant**: op = `[vault.withdraw(amt)]`, fee-only payment
(`netMint = 0`, ~0.0011 XRP + fees). FXRP lands on the PersonalAccount; getting it
back to the XRP Ledger (FAssets redeem) is a later feature — say so in the UI.

## C. Failure modes (from the spike research)

| Failure | Detect | Recovery |
|---|---|---|
| Inner call reverts | executor tx reverts `CallFailed` | mint unwinds; XRP parked at Core Vault; manual `0xE0` skip-memo runbook, then re-execute + fee-only retry op |
| FDC round miss | DA returns empty | re-request same `abiEncodedRequest` next round; payment provable for 24h |
| Nonce race | `InvalidNonce` | impossible with one-open-intent rule; else rebuild with current nonce |
| Agent offline mid-flow | status stalls | intent + tx hash are durable; agent resumes on restart (execution is idempotent) |

## D. Order of work

1. Agent module + validation + status (1–1.5d) — testable with the spike script as the "web".
2. Web build/QR/handoff flow (1d).
3. Tracker + copy + mobile pass (0.5–1d).
4. Re-run the spike end-to-end THROUGH the product, then it goes in the demo video.
