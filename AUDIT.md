# Torch implementation audit — Aug 1, 2026

Run after a Flare DevRel suggested having an AI agent analyze the implementation for missed risks. **Re-verified Aug 1** — every finding re-checked against source; one of the originally proposed fixes (the `executeTrigger` clamp) was found to be wrong and is corrected in place below. Three independent adversarial reviewers over the contracts, the FDC/oracle layer, and the agent + frontend, plus a manual economics pass. **Every finding below was re-verified by reading the actual code** — anything that could not be reproduced in the source was dropped.

Scope: `TorchVaultV2.sol` (deploys Aug 6), `TorchVault.sol` (live), `TorchFdcConsumer.sol`, `FtsoV2Reader.sol`, `agent/src/*`, `web/src/*`.

## Status — Aug 1, end of day

**Fixed and shipped:**
- `ad78297` (live on usetorch.xyz): `waitTx` now throws on a reverted receipt instead of reporting success; XRP liquidation price uses the coupled formula; `Positions` Close/Cancel gated on a real connection and errors surfaced; liquidated PnL clamped to margin.
- `9b15d70` (v2, ready for Aug 6): `_requireNoWorseThanOracle` on all four executor price paths; liquidation eligibility decided at a fresh oracle read; pause stops new risk instead of exits; zero-price fails closed; `setParams` bounded. **29 tests passing; the 6 new/updated ones fail against the pre-fix contract.**
- `22cbaad`: agent price formatting no longer emits exponential notation, which would have broken every BTC order on the production flip.

- `c6a9306`: claim accuracy. The UI now reads execution mode from the enclave's own status endpoint, so it cannot describe exchange routing while running in mock mode. New "What is not proven" section on /verify. Overclaims corrected in README, Landing and the Verify hero.
- `84176b8`: `cancelCloseRequest` and `selfClose` mean a stalled executor can no longer trap margin (the Jul 24-27 outage scenario). Delay bounded 15 min to 1 day.
- `1c1ddbf`: agent stops retrying doomed fills after 5 attempts (was unbounded, ~1200 fee-paying round trips an hour), liquidation failures are logged and counted instead of swallowed, the heartbeat and status endpoint report a stalled loop (503) instead of green, and the build is reproducible (`agent/package-lock.json` + `npm ci`).
- `24da1f6`: 13 tests for TorchFdcConsumer, covering both what the attestation proves and what it deliberately does not. **46 passing overall.**

- `f108b93`: the three pre-flip gaps. Partial fills are detected and unwound instead of becoming unhedged exposure; orders carry a deterministic client order id so a restart reconciles against the exchange instead of double-filling; and `acceptRequest` closes the free-cancel option without ever letting a dead executor strand a request. **51 passing.**

**Still open, deliberately:**
- `:latest` needs pinning to a digest, but only **after** CI rebuilds the image from the agent changes above. This is an Aug 6 deploy step, not a code change.
- The Hyperliquid account in `TorchFdcConsumer.sol:61` is a compile-time constant with no rotation path, and is not linked to the vault's mutable `executor`. Rotating the exchange account would silently brick both attestation entry points. Wants an owner-settable value with an event.
- Owner powers (`setOracle`, `setExecutor`, `setParams`) have no timelock. Deliberate on testnet for iteration speed; must change before real money.
- The vault still has no partial-close or funding-rate support. Known, on the roadmap, not a defect.

---

## Bottom line

No stranger can take user funds, and the core accounting is genuinely sound — FXRP conservation holds on every settlement branch in both vault versions, verified algebraically rather than trusted from the tests. But this found more than the contracts. Five things affect the **live site or live users right now**, including one bug of mine that tells users a deposit succeeded when it reverted, and one path where a user who clicks Close has no exit if the executor stalls — which is exactly what happened during the July credits outage.

Two themes run through the rest. First, **several guarantees are enforced against a price the executor supplies rather than the oracle itself**, which makes the trust model weaker than our public wording claims. Second, **mock mode has been hiding real bugs** — one line of price formatting will break every BTC order the moment production execution is switched on.

The single most valuable output is not a bug: three public claims are stronger than the code supports and need rewording before submission.

---

## Fix now — these affect the live site and live users

### 0a. `waitTx` reports reverted transactions as successes
`web/src/lib/hooks.ts:27-43` — **my bug, introduced with the receipt-lag workaround.**

```solidity
await c.waitForTransactionReceipt({ hash, timeout: 180_000, ... });
} catch { /* swallowed */ }
```

The receipt is awaited but `receipt.status` is **never inspected**, and viem resolves normally for a mined-and-*reverted* transaction. It compounds with `Ticket.tsx:67` (`gas: 3_000_000n`), which makes viem skip `eth_estimateGas` and therefore skip the client-side revert preview. Full chain: revert not previewed → tx sent → reverts on-chain → `waitTx` swallows it → `AccountPanel.tsx:95` tells the user *"Deposited 10 FXRP as margin."* when nothing moved.

Fix: return the receipt and `if (receipt?.status === "reverted") throw`. Keep the swallow for the timeout case only — that was the original, correct purpose.

### 0b. A user who clicks Close has no exit if the executor stalls
`TorchVault.sol:224` sets `CloseRequested`; the only transitions out are `confirmClose:254` and `liquidate:264`, both `onlyExecutor`. `cancelRequest` requires `Status.Requested`, so it does not apply. **There is no user-side escape from `CloseRequested`.**

This is not hypothetical — it is exactly what happened during the July 24-27 Phala credits outage, when fills froze for three days and positions sat stuck. Any user who had clicked Close in that window had their margin trapped with no recourse.

Fix: allow the owner (or the user after a timeout) to move `CloseRequested` back to `Open`, or settle it at the oracle price after a grace period.

### 0c. The `:latest` image tag undermines the attestation claim
`agent/docker-compose.yml:10` — `image: ghcr.io/big14way/torch-executor:latest`

dstack's attestation binds the *compose hash*, not the image content. The compose hash stays stable while the tag's underlying image is mutable, so anyone with GHCR push access could swap the image and the attestation would still verify. We already learned the digest-pinning lesson operationally (Phala nodes caching `:latest`); the security consequence is the same lesson. Until this is a `@sha256:` digest, "the signing key lives in attested hardware" on `/verify` is not backed end-to-end.

Related: `agent/` has no lockfile, and the Dockerfile installs unpinned `^` ranges on the mutable `node:22-slim` tag, so no third party can reproduce the attested digest.

### 0d. The displayed liquidation price is wrong for XRP — the flagship market
`Ticket.tsx:34-38` and `Positions.tsx:16-18` use `entry * (1 + M - 1/lev)`, which is correct only when margin value is independent of the mark. For XRP-PERP it is not: the contract re-marks margin through `_fxrpToUsd6` on the *same* XRP/USD feed as the mark.

I derived it independently and confirmed the reviewer's math. Correct ratio for an XRP long is `1.05·L/(L+1)`:

| Leverage | True liquidation | UI shows | Gap |
|---|---|---|---|
| 3x | −21.2% | −28.3% | 7.1 points |
| 5x | −12.5% | −15.0% | 2.5 points |
| 10x | −4.5% | −5.0% | 0.5 points |

The UI puts liquidation *further away than it is*, so a trader sizing a stop off that number gets liquidated first. The same wrong figure drives the health bar and its colors. Fix: branch on `marketKey === "XRP"` and use the coupled formula.

### 0e. Watch mode has one forgotten gate (cosmetic, not a security hole)
`Positions.tsx:150-160` — the Close/Cancel buttons are gated only on `isPending`; the file has **no connection check at all**. While watching someone else's account those buttons render enabled, and clicking throws into a bare `catch {}` that surfaces nothing. No funds are at risk (writes sign with the connected wallet, and the contract enforces `p.owner == msg.sender`), but it is silent dead UI. Add `!isConnected` and surface the error.

---

## Must fix before the Aug 6 deploy

### 1. Liquidation eligibility is decided at the executor's price, not the oracle
`TorchVaultV2.sol:339-349` (and live v1 `TorchVault.sol:262-271`)

```solidity
_checkBand(markets[p.market].feedId, markPrice6);
int256 pnlUsd6 = _pnlUsd6(p, markPrice6);   // <-- executor's number
...
if (equityUsd6 > maintenanceUsd6) revert NotLiquidatable();
```

The NatSpec says "the liquidation condition is re-verified on-chain." It is re-verified against `markPrice6`, which the executor just passed in. `_checkBand` only proves that number is within ±1.5% of FTSO, so the executor holds a 1.5%-of-notional option on the liquidation test itself.

At 10x, margin is 10% of notional and maintenance is 5%, so the whole buffer is 5% of notional — and 1.5% of it is executor-discretionary. A position genuinely above maintenance can be liquidated, costing the user the extra mark loss plus the 1% liquidation fee instead of the 0.08% close fee. **Two independent reviewers found this separately, and I confirmed it by reading the function.**

Fix — gate eligibility on the oracle, not on the reported number:
```solidity
int256 pnlUsd6 = _pnlUsd6(p, _price6(markets[p.market].feedId));
```
and additionally apply the settlement rule in the box below, so the price the user is *settled* at is also protected.

### 2. `executeTrigger` checks the crossing at FTSO but settles at the executor's price
`TorchVaultV2.sol:286-297`

```solidity
uint256 ftso = _price6(markets[p.market].feedId);
bool stopHit = ...;  bool tpHit = ...;
if (!stopHit && !tpHit) revert TriggerNotHit();
_checkBand(markets[p.market].feedId, exitPrice6);   // only constraint on exitPrice6
_settle(p, exitPrice6, false);
```

The crossing test and the settlement price are decoupled — nothing requires `exitPrice6` to be on the triggered side of the user's own trigger. This matters more than #1 because **v2 introduces the first close path that needs no user transaction at all**; the executor picks both the timing and the price. A take-profit at 110,000 can settle at 108,350 and still pass the band.

**Correction (re-verified Aug 1).** My first proposed fix here — clamping `exitPrice6` to the trigger price — is **wrong, and would have caused an outage.** Take a long with a stop at 90,000 when price gaps down to 85,000: the honest exit is 85,000, which is below the trigger, so the clamp reverts and the position becomes *unclosable* precisely in the gap conditions stop-losses exist for. Verified numerically before writing this. Do not implement it.

### The correct fix for 1 and 2 together: settle no worse than the oracle

The README already states the intended policy (line 37): *"Any drift between the venues inside that band is basis risk carried by the operator, never by the user."* The code does not implement that sentence — it lets the executor push the drift onto the user. So this is not really "the trust model is weaker than we claim"; it is **the code contradicting its own documented design**, which is a much easier thing to justify fixing.

One rule expresses it. For any executor-supplied settlement price, require it to be no worse for the user than the oracle at that moment:

```solidity
/// The band alone lets the executor pick the bad end of ±1.5%. Basis risk is
/// the operator's, never the user's (README): the reported price may be better
/// for the user than the oracle, never worse.
function _requireNoWorseThanOracle(bytes21 feedId, uint256 reported6, bool isLong) internal view {
    uint256 ref = _price6(feedId);
    if (isLong ? reported6 < ref : reported6 > ref) revert PriceOutOfBand(reported6, ref);
}
```

Direction check against `_pnlUsd6`: a long's PnL is `size*(mark-entry)/entry`, so a *higher* exit is better for the user → require `exitPrice6 >= ref`. A short is mirrored. Re-testing the gap case: honest exit 85,000 vs oracle 85,000 passes; a shaded 84,000 reverts. Correct in both directions, and it never blocks an honest settlement.

Apply on `confirmClose`, `executeTrigger` and `liquidate`. The same idea applies to `confirmFill` with the sign flipped (a long wants a *lower* entry), which closes the round-trip skim.

Tradeoff worth stating plainly: this makes the operator absorb genuine venue slippage rather than passing it to the user — which is exactly what the README already promises users, so it aligns code with the published policy rather than changing the deal.

### 3. Pause traps users in open positions while every executor path stays live
`TorchVaultV2.sol:258` and `:269`

`requestClose` and `setTriggers` carry `whenNotPaused`; `confirmFill`, `confirmClose`, `executeTrigger` and `liquidate` do not. So a paused vault means a user with an open position and no pre-set trigger has **no exit**, while the executor can still liquidate them at a 1% fee. `withdraw` staying open does not help — margin in an open position is not in `freeMargin`.

Fix — pause should stop *new risk*, not exits: drop `whenNotPaused` from `requestClose` and `setTriggers`, add it to `confirmFill`.

---

## Should fix before submission (Aug 14)

### 4. `_price6` has no zero guard; a zero feed permanently bricks a position
`TorchVaultV2.sol:550-558`, `TorchVault.sol:448-456`

No `value != 0` check. With `ref == 0`, `_checkBand` computes `diff = 0` and `0 > 0` is false, so **a zero price passes the band**, `entryPrice6` is stored as 0, and every later path divides by `entry` in `_pnlUsd6` → permanent revert. Margin unrecoverable. Also reachable without a literal zero: `value / (10 ** (dec - 6))` truncates to 0 for a high-decimals feed with a small value.

Fix: `if (value == 0) revert StalePrice();` in `_price6`, and reject `ref == 0 || reported6 == 0` in `_checkBand`.

### 5. `setParams` is unbounded, and v2 is the first version where that composes into a drain
`TorchVaultV2.sol:399-414` + `:373-378`

`withdrawInsurance` is correctly bounded to `insuranceFund` and cannot touch locked margin directly. But `setParams` validates nothing: owner sets `maxDeviationBps = 10_000`, the band accepts any price, the executor liquidates every position at a price that zeroes equity, all margin lands in `insuranceFund`, owner sweeps it. Two owner transactions. v1 had the same unbounded setter but no withdrawal path.

Fix: bound the setters (`maxDeviationBps <= 300`, `maintenanceMarginBps <= 2000`, fee caps), and keep a timelock in mind for mainnet.

### 6. `cancelRequest` has no fill lock — a free option against the hedge
`TorchVaultV2.sol:249-256`

No timestamp is recorded at request time (`openedAt` is only set in `confirmFill`). The executor hedges on Hyperliquid before `confirmFill` lands, so a user can watch the price and front-run `confirmFill` with `cancelRequest` when the fill went against them, leaving Torch holding an unhedged position. Free, repeatable, and only exercised when it's profitable. Matters only once real execution is on (post-Aug 6 flip), but it is exactly then that it starts costing money.

Fix: record `requestedAt` and require a short cancel delay, or a two-phase `acceptRequest` the executor calls before hedging.

### 7. `setTriggers` never validates against spot
`TorchVaultV2.sol:273-277` — the inversion check only runs when **both** legs are non-zero and only compares them to each other. `setTriggers(id, 200_000e6, 0)` on a long trading at 100,000 is immediately executable by the executor. Self-inflicted, but a UI slip becomes an instant close. Validate each leg against `_price6`.

---

## Claim accuracy — the part that matters most

Three things we say publicly are stronger than the code supports. All three have honest replacements that are still compelling.

**"You don't have to trust us."** Not true as stated. The executor chooses settlement prices within ±1.5% of the oracle, and choosing the bad end on entry and exit is up to ~3% of notional per round trip. Say instead: *"The executor can't invent a price — every settlement is bounded on-chain to 1.5% of Flare's oracle feed or the transaction reverts. Inside that band it still has discretion, and that's the part we're tightening."*

**"FDC attestation is the settlement-verification path."** Verified by grep: **no vault code path references `TorchFdcConsumer`**. Attestation cannot block, reverse, or penalize anything — it is an after-the-fact public receipt. Say: *"an after-the-fact receipt anyone can verify," not "settlement verification."*

**What the attestation actually proves** (use this verbatim, it's still a strong claim): Flare's validators independently re-fetched Hyperliquid and proved on-chain that the order id the vault recorded for a position really exists in our exchange account, with the right market and side, and no other position is bound to it. Every request parameter is pinned on-chain — URL, method, headers, query, body, JQ transform and ABI signature — so the proof can't be for a different account or endpoint.

**What it does not prove:** that the fill's price or size matched the position (not compared), that the fill happened near when the position opened (`time` is decoded but never checked — this gap was not previously documented), or that the order id was chosen honestly (`hlOid` is executor-supplied and unvalidated, so any real fill of the same market and side can be attached to any position). It proves co-existence, not causation.

The cheapest real improvement: pin the timestamp — `require(f.time / 1000` within a window of `p.openedAt)`. That closes the "attach an old unrelated fill" gap for one line.

---

## Agent — must fix before the production Hyperliquid flip

### 8. `toPrecision(5)` emits exponential notation and will break every BTC order
`agent/src/exchange.ts:231` — `return px.toPrecision(5);`

Verified in node: `(124690.56).toPrecision(5)` → `"1.2469e+5"`. BTC is above $100k, so every BTC order breaks the moment `EXECUTION_MODE=testnet` goes on — and **mock mode can never surface this**, which is why it survived the spike. The file's own line 14 says "VERIFY BEFORE DEMO DAY"; this is that verification.

Fix: format with `toFixed` against the asset's `szDecimals`, never `toPrecision`.

### 9. A band rejection becomes an unbounded fee-burning retry loop
`agent/src/index.ts:281-321`. If `confirmFill` reverts `PriceOutOfBand` (routine on illiquid HL testnet), the position stays `Requested`, and the next cycle 3 seconds later places **another real HL order**. No backoff, no attempt cap, no give-up state — roughly 1,200 round trips an hour, each paying taker fees on both legs.

Fix: per-position failure counter; stop after N and surface it in the status JSON.

### 10. Partial fills silently create unhedged exposure
`agent/src/exchange.ts:200-209` reads `filled.avgPx` and ignores `totalSz` — the `Fill` interface has no size field. A $300 fill on a $1,000 order records the full size on-chain at the partial's price, leaving $700 of naked directional risk against the insurance fund.

### 11. Liquidation failures are swallowed entirely
`agent/src/index.ts:373-375` catches everything with a comment about expected `NotLiquidatable` races — but the same catch hides out-of-gas, RPC failure, and stuck nonces. No log, no counter, nothing in the status JSON. That is precisely the gas-starvation blind spot the surrounding code claims to have closed. Filter on the error text and count the rest.

### 12. Restart mid-operation can double-fill
`inFlight` is an in-memory `Set`, so a crash between placing the HL order and `confirmFill` mining leads to a second real order on restart. The code then sees the first confirm landed, logs "confirm landed despite error", and deliberately skips the unwind — leaving orphaned 2x exposure. Related: `exchange.open()` uses bare `fetch` with no timeout and sends no client order id, so reconciliation after a lost response is impossible.

### 13. Smaller agent items
- Heartbeat never checks `lastLoopAt`, so it can print healthy while the loop is wedged; the status endpoint always returns 200. Return 503 when `ageSec` is stale.
- `waitMined` is inline in the per-position loop with a 90s timeout, so one stuck transaction delays every later position — including liquidations.
- `HL_SMOKE` reports `ok: true` in mock mode without touching Hyperliquid. Gate it on `MODE === "testnet"`.
- The public status endpoint reflects raw exception text with `access-control-allow-origin: *`. No key leaks on any traced path, but it is an uncontrolled channel out of the key-holding process.

## Frontend — before submission

- **The UI claims Hyperliquid routing while the deployment is in mock mode.** `Ticket.tsx:167-168` shows "Flare vault, TEE, Hyperliquid" unconditionally and `:195` says "The TEE agent is filling it on the exchange." Today every fill is `MockExchange` at the FTSO mark. The enclave status endpoint already publishes `executionMode` — read it and label the route honestly. Note also that XRP is not listed on HL testnet, so even after the flip it falls back to the FTSO mark.
- **Liquidated positions display a loss larger than the user could take.** `Positions.tsx:136` renders `p.pnlFxrp` raw, which the contract stores unclamped; `hooks.ts:283` already clamps for the leaderboard, so the two disagree about the same trade. The column also silently switches units between USD (open) and FXRP (settled).
- **"Deposit" silently sends an unlimited approve** (`AccountPanel.tsx:84-88`). Risk is bounded, but say so in the note or approve the exact amount.
- **`HOUSE_WALLETS` is dead code** — defined at `hooks.ts:235-242`, imported nowhere. The board advertises "top 10 paid" and house entries are indistinguishable from testers. The payout-ineligibility is a manual promise, not code.
- **Stale positions can render as live forever** — `hooks.ts:134-138` caches successful reads and never evicts, so a position that has since liquidated keeps showing as Open with a ticking PnL while its individual read fails.
- **`"1e5"` in an amount field becomes `15`** — the sanitizer strips the `e`. Sub-microunit amounts silently disable the button with no explanation.
- No checksum validation on the pasted r-address, so a typo resolves to a valid-looking empty Smart Account indistinguishable from "your account is empty."

## Backlog / accepted risk

- `TorchFdcConsumer.sol:61` hardcodes the Hyperliquid account at compile time with no rotation path, and it is not linked to the vault's mutable `executor`. Rotating the HL account bricks both entry points silently. Make it an owner-settable value with an event.
- **The FDC consumer has zero test coverage** — grep for `attest` in `contracts/test/` returns nothing. Staleness, decimals normalization, zero price and every FDC guard are untested. This is the largest coverage gap in the repo.
- `p.pnlFxrp` stores the *uncapped* PnL when `PayoutCapped` fires, so any indexer summing it overstates realized PnL.
- Total-loss liquidations route no fee to the treasury (`gross == 0` → `fee = 0`), which is the one case the v2 fee-routing comment claims to have fixed.
- `renounceOwnership` is not overridden; `setExecutor(address(0))` makes every open position permanently unclosable. Both are owner footguns worth blocking.
- Move the treasury transfers in `confirmFill` and `_settle` to the end of their functions. Reentrancy is genuinely blocked today by `nonReentrant` on every value-moving entrypoint, but the safety rests on one modifier a future refactor could drop.
- v2 is referenced only by its test file — the Aug 6 deploy also needs the agent and web pointed at the new ABI.

---

## What is genuinely solid (defend this confidently)

- **Conservation.** `Δ(freeMargin + locked margin + insuranceFund) == Δ(token balance)` verified algebraically on all three `_settle` branches in v2 and both in v1. No path creates or destroys FXRP. Rounding truncates toward the fund by ≤1e-6 FXRP — seven orders of magnitude below gas cost, so there is no repeatable-for-profit path.
- **The v2 fee-routing fix is real.** I confirmed v1 pays the treasury nothing on profitable closes (`available` is 0 when payout exceeds margin) and that v2 correctly takes the fee from `gross` on winners and losers alike.
- **`openNotionalUsd6` accounting is clean.** One increment, one decrement, every decrement matched; no underflow, no cap bypass, no griefing leak.
- **Trigger directionality is correct** in all four cases (long/short × SL/TP), and triggers cannot fire on a closed, cancelled or liquidated position.
- **The executor cannot withdraw.** Verified: only three token-transfer-out paths exist in v1 — user withdrawal and two treasury fee transfers. None is reachable by the executor. This claim is true as stated.
- **FDC request pinning is unusually thorough.** All seven `RequestBody` degrees of freedom are pinned; most Web2Json consumers pin only the URL. JQ/URL injection is impossible — the only dynamic input is a `uint64` rendered as ASCII digits. Replay is blocked in both namespaces. Proof verification goes through `ContractRegistry.getFdcVerification()`, not a hardcoded verifier.
- **Watch mode is safe.** `isConnected` comes from wagmi and is never influenced by the watched address; every write button is gated on it; and `writeContractAsync` signs with the connected wallet regardless. A watched account cannot trigger a write.
- **No DoS or cross-user griefing.** No unbounded loops in any state-changing function.

## Limits of this review

Not a substitute for a professional audit. Not checked: the compiled bytecode, the live deployment's storage against source, FAssets FXRP's actual transfer semantics (hooks were assumed possible), Hyperliquid's API behavior under adversarial conditions, TEE attestation validity end-to-end, or economic modelling under correlated stress beyond the payout-cap analysis. The frontend and agent review was still running when this was written and is not fully reflected here.
