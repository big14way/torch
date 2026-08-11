# Torch on Flare Confidential Compute

Torch's executor key has lived in a Phala Intel TDX enclave since July. This
directory is the move onto **Flare's own** confidential compute: a Flare
Compute Extension (FCE), registered and running on Coston2, that answers one
question the chain cannot answer for itself — *what actually filled on
Hyperliquid?* — and signs the answer with a key that never leaves the enclave.

Everything here is deployed. Addresses and receipts are in the table below.

## What it does

One operation, `TORCH` / `ATTEST_FILL`. Given a vault position id and the
Hyperliquid order id the vault recorded for it at `confirmFill`, the enclave
queries Hyperliquid itself and reports what it found — coin, side, price, size,
timestamp — plus a signature over the exact digest
[`TorchTeeExecutor.fillDigest`](../contracts/contracts/TorchTeeExecutor.sol)
verifies on-chain.

The caller supplies **no prices**. It can ask a question; it cannot answer one.
And when the claimed order id does not exist in our account, the enclave says so
(`found: false`) — the honest negative matters as much as the positive.

```
TorchInstructionSender.requestFillAttestation(positionId, oid)   ← anyone
        │  TeeExtensionRegistry.sendInstructions
        ▼
Flare data providers relay under consensus (50%+ signature weight)
        ▼
ext-proxy ──► TEE node ──► POST /action  →  this extension
        │                                     ├─ look up the fill (warm cache)
        │                                     └─ sign fillDigest via /sign
        ▼
signed result, retrievable by anyone from the extension proxy
```

## Why this shape, and not a full executor port

An FCE is **instruction-driven**: it runs when an on-chain instruction reaches
it through data-provider consensus. Torch's executor is an autonomous polling
loop. Two of its jobs have no instruction to hang off at all —
nothing emits *"this position just became liquidatable"*, and nothing emits
*"the oracle just crossed your stop"*. Routing those through a consensus relay
would make liquidations slower, not safer.

So the split is deliberate, and it is enforced on-chain by
[`TorchTeeExecutor`](../contracts/contracts/TorchTeeExecutor.sol) rather than
asserted in prose:

| Vault call | Who | Why |
|---|---|---|
| `confirmFill` | **enclave signature required** | the one number the operator could previously choose |
| `acceptRequest`, `confirmClose`, `executeTrigger`, `liquidate` | agent, unchanged | time-critical, or no triggering event exists |

The vault keeps every guard it already had — FTSOv2 band, never-worse-than-
oracle, staleness. The adapter only *narrows* what reaches it. And because
`setExecutor` is owner-settable, wiring it in is one transaction and reversible
in one.

## Deployed on Coston2 (chain 114)

| Piece | Address / value |
|---|---|
| Extension id | **66154** |
| TorchInstructionSender | [`0x88d0c142844C418ae27e9B4bd730376ee7F3799b`](https://coston2-explorer.flare.network/address/0x88d0c142844C418ae27e9B4bd730376ee7F3799b) |
| TorchTeeExecutor (adapter) | [`0x4059aE416F06214E92f66a544064b529A31689Aa`](https://coston2-explorer.flare.network/address/0x4059aE416F06214E92f66a544064b529A31689Aa) |
| TorchVaultV2 (guarded) | [`0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd`](https://coston2-explorer.flare.network/address/0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd) |
| FlareTeeManager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |

A live run, end to end: instruction tx
[`0x1d84be38…3f2c`](https://coston2-explorer.flare.network/tx/0x1d84be384922252f1eb7e3acf89a24248b5b1871b2845f84f7f5bcc2e5d63f2c)
→ the enclave returned

```json
{"positionId":1,"oid":57497722789,"coin":"BTC","side":"Open Long",
 "px":"64863.0","sz":"0.00024","time":1786005181517,"found":true}
```

`64863.0` is the entry price TorchVaultV2 stores for position #1 — the enclave
went and looked, and got the same answer the vault recorded.

## Honest status

- Attestation runs in **`SIMULATED_TEE=true`** mode on Coston2, which is what
  Flare's own guides prescribe for development and what Flare DevRel confirmed
  qualifies. The chain, the registration, and the data-provider consensus are
  real; the hardware quote is simulated. No Confidential Space VM is involved.
- `TorchTeeExecutor` is **deployed but not yet wired**: the live vault's
  `executor` still points at the Phala agent. Until `setExecutor` is called,
  the adapter is inert.
- **Known operational trap:** rebuilding the node image mints a new enclave key,
  which requires recreating `redis` + `ext-proxy` (the proxy's identity is
  set-once) *and* re-registering. Each cycle leaves the previous teeId
  registered and PRODUCTION, and `getRandomTeeIds` will happily route
  instructions to a container that no longer exists. Pause stale machines as
  you go, or rebuild sparingly.

## Files

| File | Role |
|---|---|
| `extension/extension.go` | the handler: fill lookup, digest, signing |
| `extension/types.go` | request/response wire types |
| `extension/config.go` | `TORCH` / `ATTEST_FILL` identifiers |
| `contracts/TorchInstructionSender.sol` | on-chain entry point |
| `../contracts/contracts/TorchTeeExecutor.sol` | the adapter the vault trusts |

Built on [`flare-foundation/fce-extension-scaffold`](https://github.com/flare-foundation/fce-extension-scaffold);
these are the files that differ from it. Deployment config (keys, indexer
credentials, tunnel) stays out of the repo.
