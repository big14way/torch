import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  hexToString,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import deployments from "./generated/deployments.json" with { type: "json" };
import vaultAbiJson from "./generated/TorchVault.abi.json" with { type: "json" };
import oracleAbiJson from "./generated/MockFtsoV2.abi.json" with { type: "json" };
import { MockExchange, HyperliquidTestnet, type Exchange } from "./exchange.js";
import { getAttestation, inEnclave } from "./tee.js";
import { createServer as createHttpServer } from "node:http";

const vaultAbi = vaultAbiJson as Abi;
const oracleAbi = oracleAbiJson as Abi;

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const MODE = (process.env.EXECUTION_MODE || "mock") as "mock" | "testnet";
// Executor key. In Confidential Space with no key supplied, GENERATE it inside
// the enclave so the private key never exists outside the attested image; the
// operator then points the vault at its address via setExecutor().
const KEY: `0x${string}` =
  (process.env.EXECUTOR_PRIVATE_KEY as `0x${string}`) ||
  (inEnclave()
    ? generatePrivateKey()
    : // Hardhat account #1: public dev key, never holds value
      ("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as `0x${string}`));

const POLL_MS = 3_000;
const WALK_MS = 8_000;
// FTSO-reading vault txs (confirmFill/confirmClose/liquidate) can be
// under-estimated by eth_estimateGas on Flare; pin a generous gas limit.
const TX_GAS = 3_000_000n;

// Position status enum mirror of TorchVault.Status
const S = { None: 0, Requested: 1, Open: 2, CloseRequested: 3, Closed: 4, Liquidated: 5, Cancelled: 6 };

type Position = {
  id: bigint;
  owner: Address;
  market: `0x${string}`;
  isLong: boolean;
  marginFxrp: bigint;
  sizeUsd6: bigint;
  entryPrice6: bigint;
  exitPrice6: bigint;
  pnlFxrp: bigint;
  hlOid: bigint;
  status: number;
  openedAt: bigint;
  closedAt: bigint;
};

async function main() {
  const account = privateKeyToAccount(KEY);
  const pub = createPublicClient({ transport: http(RPC_URL) });
  const wallet = createWalletClient({ account, transport: http(RPC_URL) });
  const chainId = await pub.getChainId();

  const att = await getAttestation();
  console.log("");
  console.log("  TORCH executor agent");
  console.log(`  chain      ${chainId} (${deployments.network})`);
  console.log(`  vault      ${deployments.vault}`);
  console.log(`  executor   ${account.address}`);
  console.log(`  mode       ${MODE}`);
  console.log(`  tee        ${att.mode} :: ${att.note}`);
  if (att.mode !== "dev") {
    console.log(`  digest     ${att.imageDigest ?? "unknown"}`);
    console.log(`  >> point the vault here: setExecutor(${account.address})`);
    if (att.token) console.log(`  attestation token (publish this):\n${att.token}`);
  }
  console.log("");

  // Status endpoint: exposes the enclave-generated executor address + attestation
  // so it can be read/verified without container-log access (served via the gateway).
  // Loop-health telemetry, surfaced in the status JSON so "idle" and "wedged"
  // are distinguishable from outside (the Jul 22 audit found a 16h silence
  // that was unprovable either way).
  const health = {
    lastLoopAt: 0,
    loops: 0,
    gasWei: 0n,
    gasLow: false,
    liqFailures: 0,        // liquidation attempts that failed for a REAL reason
    lastLiqFailure: "",
    givenUp: [] as string[], // positions parked after repeated fill failures
  };
  // Per-position fill-failure counts. Without this a band revert (routine on an
  // illiquid testnet book) re-places a real exchange order every 3s forever,
  // burning taker fees on both legs with no backoff and no give-up state.
  const fillFailures = new Map<string, number>();
  const MAX_FILL_ATTEMPTS = 5;
  // HL egress spike results (HL_SMOKE=1 runs a one-shot exchange round trip
  // instead of the vault loop; see the gate below runLoop's definition).
  let smokeResult: Record<string, unknown> | undefined;

  const STATUS_PORT = Number(process.env.PORT || 0);
  if (STATUS_PORT > 0) {
    createHttpServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("access-control-allow-origin", "*");
        // A wedged loop used to answer 200 with a cheerful body, so a naive
        // uptime check saw green while no order was being filled. Say 503 when
        // the loop has stopped ticking; the body still explains why.
        const ageSec = health.lastLoopAt ? Math.round((Date.now() - health.lastLoopAt) / 1000) : null;
        const stalled = ageSec !== null && ageSec > 60;
        res.statusCode = stalled ? 503 : 200;
        res.end(
          JSON.stringify(
            {
              service: "torch-executor",
              chainId,
              vault: deployments.vault,
              executor: account.address,
              executionMode: MODE,
              tee: { mode: att.mode, imageDigest: att.imageDigest ?? null },
              loop: {
                lastTick: health.lastLoopAt ? new Date(health.lastLoopAt).toISOString() : null,
                ageSec,
                cycles: health.loops,
                stalled,
              },
              gas: { balanceWei: health.gasWei.toString(), low: health.gasLow },
              failures: {
                liquidations: health.liqFailures,
                lastLiquidationError: health.lastLiqFailure || null,
                givenUpPositions: health.givenUp,
              },
              ...(smokeResult ? { smoke: smokeResult } : {}),
            },
            null,
            2
          )
        );
      })
      .listen(STATUS_PORT, () => console.log(`  status     serving on :${STATUS_PORT}`));
  }

  if (account.address.toLowerCase() !== deployments.executor.toLowerCase()) {
    console.warn(
      `  WARNING executor key (${account.address}) != vault executor (${deployments.executor}).\n` +
        `  Fills will revert. Fix EXECUTOR_PRIVATE_KEY or redeploy.`
    );
  }

  const vault = { address: deployments.vault as Address, abi: vaultAbi } as const;

  const markKey = (m: `0x${string}`) => hexToString(m, { size: 32 });

  const markPrice6 = async (marketKey: string): Promise<bigint> => {
    const m = deployments.markets.find((x) => x.key === marketKey);
    if (!m) throw new Error(`Unknown market ${marketKey}`);
    return (await pub.readContract({
      ...vault,
      functionName: "markPrice6",
      args: [m.id as `0x${string}`],
    })) as bigint;
  };

  // The v2 vault rejects any reported price worse for the user than the
  // oracle, and a real venue legitimately fills a few bps away from FTSO.
  // Report the user-favorable side of (fill, mark) and let the hedge book
  // carry the basis — the documented operator risk. userPays: long entry /
  // short exit (clamp down to the mark); otherwise the user receives
  // (clamp up). Mock and FTSO-fallback fills return the mark, so this is
  // a no-op for them.
  const clampToOracle = async (
    marketKey: string,
    id: bigint,
    price6: bigint,
    userPays: boolean
  ): Promise<bigint> => {
    const mark = await markPrice6(marketKey);
    const clamped = userPays ? (price6 < mark ? price6 : mark) : (price6 > mark ? price6 : mark);
    if (clamped !== price6) {
      const bps = ((price6 > mark ? price6 - mark : mark - price6) * 10_000n) / mark;
      log(id, `basis absorbed: reporting ${fmt6(clamped)} (oracle) vs venue fill ${fmt6(price6)} — ${bps} bps carried by the hedge book`);
    }
    return clamped;
  };

  let exchange: Exchange;
  if (MODE === "testnet") {
    // Builder code: Torch's revenue rail on routed Hyperliquid flow. The venue
    // pays HL_BUILDER_ADDRESS f tenths-of-a-bp per fill (default 50 = 5 bps,
    // perp cap 100 = 10 bps). Requires a one-time approveBuilderFee by the
    // trading account.
    const builderAddr = process.env.HL_BUILDER_ADDRESS as `0x${string}` | undefined;
    exchange = new HyperliquidTestnet(
      process.env.HL_API_URL || "https://api.hyperliquid-testnet.xyz",
      process.env.HL_PRIVATE_KEY || "",
      markPrice6, // FTSO-mark fallback for symbols HL testnet does not list (e.g. XRP)
      builderAddr
        ? { address: builderAddr, feeTenthBps: Number(process.env.HL_BUILDER_FEE_TENTH_BPS || 50) }
        : undefined
    );
    console.log(
      `  Routing orders to Hyperliquid testnet${builderAddr ? ` (builder code ${builderAddr.slice(0, 8)}…)` : ""}. Smoke-test before demos.`
    );
  } else {
    exchange = new MockExchange(markPrice6);
    console.log("  Mock execution: fills at the FTSO mark. Full local loop.");
  }

  // ---- local price walker (mock oracle only) ------------------------------
  const walk = process.env.PRICE_WALK ?? "auto";
  const shouldWalk = walk === "true" || (walk === "auto" && MODE === "mock" && chainId === 31337);
  if (shouldWalk) {
    console.log("  Price walker: ON (MockFtsoV2 random walk so the demo moves)");
    const oracle = { address: deployments.oracle as Address, abi: oracleAbi } as const;
    setInterval(async () => {
      for (const m of deployments.markets) {
        try {
          const px = await markPrice6(m.key);
          // +-0.35% random walk
          const bps = BigInt(Math.floor((Math.random() - 0.5) * 70));
          const next = px + (px * bps) / 10_000n;
          await wallet.writeContract({
            ...oracle,
            functionName: "setPrice",
            args: [m.feedId as `0x${string}`, next],
            chain: null,
          });
        } catch (e) {
          console.error(`  walker ${m.key}:`, (e as Error).message);
        }
      }
    }, WALK_MS);
  }

  // ---- main settlement loop ------------------------------------------------
  const seenClosed = new Set<string>();
  // Positions with a fill/close currently in flight. Prevents the poll loop
  // from placing a second exchange order before the first confirm tx mines
  // (the double-fill race: a re-poll sees the position still Requested).
  const inFlight = new Set<string>();
  // Positions in a terminal state (closed/cancelled/liquidated). Skipped on
  // future polls so per-loop RPC load stays proportional to ACTIVE positions,
  // not the ever-growing total (public RPCs 429 otherwise).
  const finalized = new Set<string>();

  // Read the real maintenance margin from the vault instead of assuming the
  // 500 bps default — the owner can change it, and a stale hardcode would
  // make the agent fire liquidations the contract then rejects (or miss them).
  const maintenanceBps = BigInt(
    (await pub.readContract({ ...vault, functionName: "maintenanceMarginBps" })) as number
  );
  console.log(`  Maintenance margin: ${Number(maintenanceBps) / 100}% (read from vault)`);
  console.log(`  Watching positions every ${POLL_MS / 1000}s...\n`);

  // Single-flight loop: schedule the next cycle only after this one finishes,
  // so cycles never overlap and stack RPC reads on top of each other. The
  // launch-surge stall came from setInterval firing every 3s regardless of
  // whether the prior (now slow, sequential) cycle had returned, which
  // multiplied reads until the public RPC 429'd and the loop wedged.
  /** Re-read a position and check whether it reached one of the expected
   * states — the on-chain source of truth for "did my tx actually land". */
  const confirmedOnChain = async (id: bigint, expect: number[]): Promise<boolean> => {
    try {
      const p = (await pub.readContract({ ...vault, functionName: "getPosition", args: [id] })) as Position;
      return expect.includes(p.status);
    } catch {
      return false;
    }
  };

  /** Coston2-tolerant receipt wait. Receipts on this RPC routinely lag past
   * viem's default window while the tx has in fact mined (22 such false
   * negatives in the Jul 18-21 logs, every one confirmed on-chain later, 11 of
   * them triggering phantom unwinds). On timeout, trust chain state over the
   * receipt endpoint before declaring failure. */
  const waitMined = async (hash: `0x${string}`, id: bigint, expect: number[]): Promise<void> => {
    try {
      await pub.waitForTransactionReceipt({ hash, timeout: 90_000, pollingInterval: 3_000 });
    } catch (e) {
      if (await confirmedOnChain(id, expect)) {
        log(id, `receipt endpoint lagged but state confirmed on-chain (tx ${hash.slice(0, 10)})`);
        return;
      }
      throw e;
    }
  };

  // Heartbeat: every ~10 min log liveness and check the executor's gas against
  // 10x the viem 3M-gas prefund floor (the Jul 15 outage was a silent gas
  // starvation nobody could see from outside).
  const heartbeat = async () => {
    try {
      const [bal, gasPrice] = await Promise.all([
        pub.getBalance({ address: account.address }),
        pub.getGasPrice(),
      ]);
      health.gasWei = bal;
      const floor = 3_000_000n * gasPrice * 10n;
      health.gasLow = bal < floor;
      const ageSec = health.lastLoopAt ? Math.round((Date.now() - health.lastLoopAt) / 1000) : -1;
      const stalled = health.lastLoopAt !== 0 && ageSec > 60;
      const line =
        `heartbeat: loops=${health.loops} gas=${(Number(bal) / 1e18).toFixed(2)} C2FLR` +
        `${health.gasLow ? " LOW — top up now" : ""}` +
        // the loop reschedules itself in a finally; if lastLoopAt stops moving
        // the loop is wedged and a bare "still alive" line would be a lie
        `${stalled ? ` LOOP STALLED ${ageSec}s — not filling orders` : ""}` +
        `${health.liqFailures > 0 ? ` liqFailures=${health.liqFailures}` : ""}`;
      console.log(new Date().toISOString(), line);
    } catch (e) {
      console.error("heartbeat error:", (e as Error).message);
    } finally {
      setTimeout(heartbeat, 600_000);
    }
  };
  heartbeat();

  const runLoop = async () => {
    try {
      const count = (await pub.readContract({
        ...vault,
        functionName: "positionsCount",
      })) as bigint;

      for (let i = 0n; i < count; i++) {
       try {
        if (finalized.has(i.toString())) continue; // terminal position; skip the RPC read
        const p = (await pub.readContract({
          ...vault,
          functionName: "getPosition",
          args: [i],
        })) as Position;
        const key = markKey(p.market);

        if (p.status === S.Requested) {
          const idStr = p.id.toString();
          if (inFlight.has(idStr)) continue; // fill already in flight; don't double-order
          if ((fillFailures.get(idStr) ?? 0) >= MAX_FILL_ATTEMPTS) continue; // parked, see below
          inFlight.add(idStr);
          try {
            // Claim the request on-chain BEFORE hedging. Until this lands the
            // user may cancel freely; after it, cancelling out from under a
            // live hedge is time-boxed. Best-effort: if it fails we still fill,
            // we just keep carrying the free-cancel risk for this one.
            try {
              const acceptHash = await wallet.writeContract({
                ...vault,
                functionName: "acceptRequest",
                args: [p.id],
                gas: 200_000n,
                chain: null,
              });
              // Plain receipt wait, not waitMined: acceptRequest leaves the
              // status at Requested, so a status-based fallback would "confirm"
              // unconditionally. If the receipt lags we fall through to the
              // catch and hedge unclaimed, which is the honest outcome.
              await pub.waitForTransactionReceipt({ hash: acceptHash, timeout: 60_000, pollingInterval: 3_000 });
            } catch (acceptErr) {
              log(p.id, `acceptRequest failed, hedging unclaimed: ${(acceptErr as Error).message.slice(0, 80)}`);
            }

            // Deterministic per position, so a restart mid-order finds the
            // existing fill instead of placing a second one. HL wants a
            // 16-byte hex cloid; the vault id is unique and never reused.
            // id+1 because Hyperliquid rejects the all-zero cloid, which is
            // exactly what position id 0 on a fresh vault would produce
            // (found live: the first v2 canary parked on this).
            const cloid = ("0x" + (BigInt(p.id) + 1n).toString(16).padStart(32, "0")) as string;
            const fill = await exchange.open(key, p.isLong, p.sizeUsd6, cloid);
            const reportedEntry6 = await clampToOracle(key, p.id, fill.price6, p.isLong);
            try {
              const hash = await wallet.writeContract({
                ...vault,
                functionName: "confirmFill",
                args: [p.id, reportedEntry6, fill.oid],
                gas: TX_GAS,
                chain: null,
              });
              await waitMined(hash, p.id, [S.Open]); // hold the lock until it mines
              fillFailures.delete(idStr);
              log(p.id, `OPEN  ${key} ${p.isLong ? "long" : "short"} @ ${fmt6(fill.price6)} (${fill.venue ?? exchange.name}) tx ${hash.slice(0, 10)}`);
            } catch (confirmErr) {
              // The exchange filled but the on-chain confirm failed (band
              // revert, gas, RPC). Before unwinding, trust the chain: if the
              // position is Open the confirm actually landed. Only unwind a
              // REAL exchange fill (mock + FTSO-fallback fills have nothing
              // to unwind — the old oid!==0 guard missed mock's sequence ids).
              if (await confirmedOnChain(p.id, [S.Open])) {
                log(p.id, `confirm landed despite error (${(confirmErr as Error).message.slice(0, 60)})`);
              } else {
                if (exchange.name !== "mock" && fill.oid !== 0n) {
                  try {
                    await exchange.close(key, p.isLong, p.sizeUsd6);
                    log(p.id, `unwound exchange fill after confirm failure`);
                  } catch (unwindErr) {
                    log(p.id, `UNWIND FAILED, manual check needed: ${(unwindErr as Error).message}`);
                  }
                }
                throw confirmErr;
              }
            }
          } catch (e) {
            const n = (fillFailures.get(idStr) ?? 0) + 1;
            fillFailures.set(idStr, n);
            log(p.id, `open failed (${n}/${MAX_FILL_ATTEMPTS}): ${(e as Error).message}`);
            if (n >= MAX_FILL_ATTEMPTS) {
              // Stop paying exchange fees to retry something that keeps
              // failing. The user can still cancel the request themselves.
              if (!health.givenUp.includes(idStr)) health.givenUp.push(idStr);
              log(p.id, `GIVING UP after ${n} attempts; parked and reported in status`);
            }
          } finally {
            inFlight.delete(idStr);
          }
        } else if (p.status === S.CloseRequested) {
          const idStr = p.id.toString();
          if (inFlight.has(idStr)) continue; // close already in flight
          inFlight.add(idStr);
          try {
            const fill = await exchange.close(key, p.isLong, p.sizeUsd6);
            const reportedExit6 = await clampToOracle(key, p.id, fill.price6, !p.isLong);
            const hash = await wallet.writeContract({
              ...vault,
              functionName: "confirmClose",
              args: [p.id, reportedExit6],
              gas: TX_GAS,
              chain: null,
            });
            await waitMined(hash, p.id, [S.Closed]);
            log(p.id, `CLOSE ${key} @ ${fmt6(fill.price6)} (${fill.venue ?? exchange.name}) tx ${hash.slice(0, 10)}`);
          } catch (e) {
            log(p.id, `close failed: ${(e as Error).message}`);
          } finally {
            inFlight.delete(idStr);
          }
        } else if (p.status === S.Open) {
          // Liquidation watch: replicate the contract check off-chain, then
          // let the contract re-verify on-chain. Same in-flight guard as
          // fills — without it, polls could double-fire liquidate before the
          // first tx mines.
          const idStr = p.id.toString();
          if (inFlight.has(idStr)) continue;
          try {
            const equity = (await pub.readContract({
              ...vault,
              functionName: "equityUsd6",
              args: [p.id],
            })) as bigint;
            const maintenance = (p.sizeUsd6 * maintenanceBps) / 10_000n;
            if (equity <= maintenance) {
              inFlight.add(idStr);
              try {
                const mark = await markPrice6(key);
                const hash = await wallet.writeContract({
                  ...vault,
                  functionName: "liquidate",
                  args: [p.id, mark],
                  gas: TX_GAS,
                  chain: null,
                });
                await waitMined(hash, p.id, [S.Liquidated]); // hold until mined
                log(p.id, `LIQUIDATE ${key} @ ${fmt6(mark)} equity ${fmt6(equity)} tx ${hash.slice(0, 10)}`);
              } finally {
                inFlight.delete(idStr);
              }
            }
          } catch (e) {
            // NotLiquidatable races ARE expected and stay quiet. Everything
            // else (out of gas, RPC down, stuck nonce) means the fund is
            // eating a loss it should not, so it must be visible.
            const msg = (e as Error).message ?? String(e);
            if (!/NotLiquidatable/.test(msg)) {
              health.liqFailures += 1;
              health.lastLiqFailure = msg.slice(0, 160);
              log(p.id, `LIQUIDATION FAILED: ${msg.slice(0, 160)}`);
            }
          }
        } else if (p.status === S.Closed || p.status === S.Liquidated || p.status === S.Cancelled) {
          finalized.add(i.toString()); // never re-read a terminal position
          seenClosed.add(p.id.toString());
        }
       } catch (e) {
        // Per-position isolation: one flaky read/tx never aborts the rest of
        // the cycle (previously a single throw skipped every later position).
        console.error(`position ${i} error:`, (e as Error).message);
       }
      }
    } catch (e) {
      console.error("loop error:", (e as Error).message);
    } finally {
      health.lastLoopAt = Date.now();
      health.loops += 1;
      setTimeout(runLoop, POLL_MS);
    }
  };

  // --- HL egress spike (env-gated) -----------------------------------------
  // HL_SMOKE=1 answers one question from inside the enclave: can this CVM
  // reach Hyperliquid testnet and place a signed order? It runs a single
  // ~$12 BTC open/close through the normal adapter, publishes the result in
  // the status JSON, and NEVER starts the vault loop — so a spike CVM can
  // run alongside production with zero interference.
  if (process.env.HL_SMOKE === "1") {
    smokeResult = { startedAt: new Date().toISOString(), ok: false };
    try {
      const api = process.env.HL_API_URL || "https://api.hyperliquid-testnet.xyz";
      const t0 = Date.now();
      const res = await fetch(`${api}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
      });
      const meta = (await res.json()) as { universe: unknown[] };
      smokeResult.infoLatencyMs = Date.now() - t0;
      smokeResult.universeSize = meta.universe.length;
      console.log(`SMOKE info ok: ${smokeResult.infoLatencyMs}ms, universe=${meta.universe.length}`);

      const t1 = Date.now();
      const fill = await exchange.open("BTC", true, 12_000_000n);
      smokeResult.openMs = Date.now() - t1;
      smokeResult.openOid = fill.oid.toString();
      smokeResult.openPx6 = fill.price6.toString();
      smokeResult.venue = fill.venue ?? exchange.name;
      console.log(`SMOKE open ok: oid=${fill.oid} px=${fmt6(fill.price6)} in ${smokeResult.openMs}ms`);

      const t2 = Date.now();
      const closed = await exchange.close("BTC", true, 12_000_000n);
      smokeResult.closeMs = Date.now() - t2;
      smokeResult.closeOid = closed.oid.toString();
      console.log(`SMOKE close ok: oid=${closed.oid} in ${smokeResult.closeMs}ms`);
      smokeResult.ok = true;
    } catch (e) {
      smokeResult.error = (e as Error).message;
      console.error("SMOKE FAILED:", (e as Error).message);
    }
    console.log("SMOKE done — vault loop intentionally not started.");
    return; // status server stays up to serve the result
  }

  runLoop();
}

function fmt6(x: bigint): string {
  return (Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function log(id: bigint, msg: string) {
  console.log(`  [#${id}] ${msg}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
