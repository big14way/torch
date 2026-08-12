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
| TorchTeeExecutor (adapter) | [`0x321f606ed6cd64C2478F18053cFAb4ec1B0261de`](https://coston2-explorer.flare.network/address/0x321f606ed6cd64C2478F18053cFAb4ec1B0261de) |
| TorchVaultV2 (guarded) | [`0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd`](https://coston2-explorer.flare.network/address/0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd) |
| FlareTeeManager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |

A live run against the **live vault**, end to end. Position #21 was opened on
TorchVaultV2 and filled through the adapter:

```json
{"positionId":21,"oid":57757222726,"coin":"BTC","side":"Open Long",
 "px":"63953.0","found":true}
```

The vault stores exactly that. Check it yourself, and it does not expire:

| Read | Returns |
|---|---|
| `TorchVaultV2.getPosition(21)` | `entryPrice6 = 63953000000`, `hlOid = 57757222726` |
| `TorchTeeExecutor.oidUsed(57757222726)` | `true` — the order id is spent, so no signature can be replayed |
| `TorchVaultV2.executor()` | `0xad5b7703…a641f`, the adapter |

The price the enclave signed is the price the vault stored, and the adapter that
enforced it is the vault's executor. Both legs of #21 — open and close — landed
inside ten seconds.

The earlier proof transaction
[`0x341a670d…9162`](https://coston2-explorer.flare.network/tx/0x341a670d45dca72ff5ff164481441e4f22c53c0ffcfe014ec4c3591d143b9162)
predates the wiring and ran against a test sink rather than the live vault. It
is kept for the record — it shows the signature recovery, the registry lookup
and the replay burn in isolation — and can be reproduced with
[`scripts/proveTeeSignature.ts`](../contracts/scripts/proveTeeSignature.ts).
The live vault has since done the same thing for real, which is the run above.

## Markets the venue does not list

Hyperliquid testnet does not list XRP, so those orders never reach a venue:
no fill, no order id, nothing for the enclave to look up. Gating the vault
without a path for them would have stranded every XRP position — the enclave
rightly refuses to sign for an order id of zero.

The answer is not to let the operator name a price instead.
`TorchTeeExecutor.confirmFillAtOracle(id)` takes a position id and **no price
argument**: the contract reads FTSOv2 itself and settles there. That is
strictly less discretion than the attested path, where the operator at least
chooses which signed fill to submit.

So across both paths there is **no market on which the operator picks the entry
price** — on venue-routed markets the enclave signs it, and everywhere else the
contract reads it.

## Two keys, two different jobs

Torch has two enclaves, and it is worth being precise about which does what,
because "we use a TEE" is the kind of claim that hides more than it says.

| | **Phala enclave** (Intel TDX) | **Flare Compute Extension** |
|---|---|---|
| Holds | the executor key that sends transactions | the key that signs fill prices |
| Can | submit to the chain, pay gas, pick the moment | read Hyperliquid and state what filled |
| Cannot | **choose the entry price** | **send a transaction, or move funds** |
| Attested by | real TDX hardware, image digest published | Flare's data providers, on-chain registry |

The separation is the point. The operator can send a transaction but cannot
invent the number in it; the enclave decides the number but cannot send
anything. Neither one alone can move a position, and the chain checks both:
`onlyAgent` for who submits, `getActiveTeeMachines(66154)` for who signed.

## Which key the vault trusts

Not one we wrote down. `TorchTeeExecutor` asks
`FlareTeeManager.getActiveTeeMachines(66154)` on **every** call and accepts the
signature only if the recovered signer is in that set.

That is not defensive over-engineering, it is forced by how FCC works — as Flare
DevRel put it, *"TEE key is not preserved during restart. That is the key element
of this."* A pinned attestor address would be correct until the first restart and
silently wrong forever after, rejecting every honest fill until someone noticed
and sent an owner transaction. Reading the registry means the vault trusts
whichever enclave Flare's data providers attest **right now**, and follows the
enclave across a restart with no human in the loop. There is a test for exactly
that (`follows the enclave across a restart, with no owner action`).

One subtlety worth recording, because it cost us an evening: the node's
SignServer keccak-hashes the message it is handed **before** applying the EIP-191
personal-sign envelope. Verify the envelope over the digest alone and you recover
a different, plausible-looking address for every message — which reads exactly
like a key mismatch and is not one.

## The clamp, and why it moved on-chain

TorchVaultV2 rejects any entry price worse for the trader than Flare's oracle.
Hyperliquid does not track FTSO exactly — we measure tens of basis points of
drift — so a genuine venue fill lands on the wrong side of that guard roughly
half the time.

Torch's agent has always absorbed this by reporting the trader-favourable side
of (venue, oracle). Correct for the trader, but it is the operator's word.
`TorchTeeExecutor` now does it in the contract instead: the enclave signs what
the venue actually filled at, and the adapter stores the better of that and the
oracle, emitting **both** numbers.

```
FillConfirmedFromTee(id, attestedPrice6, settledPrice6, hlOid, attestor)
```

The clamp can only move a price in the trader's favour, and it hands the
operator no new freedom — a fabricated venue price still needs an enclave
signature, and the vault's own band check still applies to whatever comes out.
What changes is that the adjustment is now a pure function of a signed input,
recomputable by anyone from the log, rather than something the agent did
privately.

Without it, wiring the vault would have reverted about half of all opens.

## Honest status

- Attestation runs in **`SIMULATED_TEE=true`** mode on Coston2, which is what
  Flare's own guides prescribe for development and what Flare DevRel confirmed
  qualifies. The chain, the registration, and the data-provider consensus are
  real; the hardware quote is simulated. No Confidential Space VM is involved.
- `TorchTeeExecutor` is **wired and live**. `TorchVaultV2.executor` is the
  adapter, so no entry price reaches the vault without a signature from an
  enclave Flare currently attests. Verified end to end on Coston2: position #20
  opened at 63934.0 with `oidUsed(57756491649) == true`, and closed, both inside
  10 seconds. Reversible in one `setExecutor`, and the agent follows the vault
  either way with no redeploy.
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
