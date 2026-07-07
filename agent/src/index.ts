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
  const STATUS_PORT = Number(process.env.PORT || 0);
  if (STATUS_PORT > 0) {
    createHttpServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("access-control-allow-origin", "*");
        res.end(
          JSON.stringify(
            {
              service: "torch-executor",
              chainId,
              vault: deployments.vault,
              executor: account.address,
              executionMode: MODE,
              tee: { mode: att.mode, imageDigest: att.imageDigest ?? null },
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

  let exchange: Exchange;
  if (MODE === "testnet") {
    exchange = new HyperliquidTestnet(
      process.env.HL_API_URL || "https://api.hyperliquid-testnet.xyz",
      process.env.HL_PRIVATE_KEY || "",
      markPrice6 // FTSO-mark fallback for symbols HL testnet does not list (e.g. XRP)
    );
    console.log("  Routing orders to Hyperliquid testnet. Smoke-test before demos.");
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
  console.log(`  Watching positions every ${POLL_MS / 1000}s...\n`);

  // Single-flight loop: schedule the next cycle only after this one finishes,
  // so cycles never overlap and stack RPC reads on top of each other. The
  // launch-surge stall came from setInterval firing every 3s regardless of
  // whether the prior (now slow, sequential) cycle had returned, which
  // multiplied reads until the public RPC 429'd and the loop wedged.
  const runLoop = async () => {
    try {
      const count = (await pub.readContract({
        ...vault,
        functionName: "positionsCount",
      })) as bigint;

      for (let i = 0n; i < count; i++) {
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
          inFlight.add(idStr);
          try {
            const fill = await exchange.open(key, p.isLong, p.sizeUsd6);
            const hash = await wallet.writeContract({
              ...vault,
              functionName: "confirmFill",
              args: [p.id, fill.price6, fill.oid],
              gas: TX_GAS,
              chain: null,
            });
            await pub.waitForTransactionReceipt({ hash }); // hold the lock until it mines
            log(p.id, `OPEN  ${key} ${p.isLong ? "long" : "short"} @ ${fmt6(fill.price6)} (${fill.venue ?? exchange.name}) tx ${hash.slice(0, 10)}`);
          } catch (e) {
            log(p.id, `open failed: ${(e as Error).message}`);
          } finally {
            inFlight.delete(idStr);
          }
        } else if (p.status === S.CloseRequested) {
          const idStr = p.id.toString();
          if (inFlight.has(idStr)) continue; // close already in flight
          inFlight.add(idStr);
          try {
            const fill = await exchange.close(key, p.isLong, p.sizeUsd6);
            const hash = await wallet.writeContract({
              ...vault,
              functionName: "confirmClose",
              args: [p.id, fill.price6],
              gas: TX_GAS,
              chain: null,
            });
            await pub.waitForTransactionReceipt({ hash });
            log(p.id, `CLOSE ${key} @ ${fmt6(fill.price6)} (${fill.venue ?? exchange.name}) tx ${hash.slice(0, 10)}`);
          } catch (e) {
            log(p.id, `close failed: ${(e as Error).message}`);
          } finally {
            inFlight.delete(idStr);
          }
        } else if (p.status === S.Open) {
          // Liquidation watch: replicate the contract check off-chain, then
          // let the contract re-verify on-chain.
          try {
            const equity = (await pub.readContract({
              ...vault,
              functionName: "equityUsd6",
              args: [p.id],
            })) as bigint;
            const maintenance = (p.sizeUsd6 * 500n) / 10_000n; // 5% default
            if (equity <= maintenance) {
              const mark = await markPrice6(key);
              const hash = await wallet.writeContract({
                ...vault,
                functionName: "liquidate",
                args: [p.id, mark],
                gas: TX_GAS,
                chain: null,
              });
              log(p.id, `LIQUIDATE ${key} @ ${fmt6(mark)} equity ${fmt6(equity)} tx ${hash.slice(0, 10)}`);
            }
          } catch (e) {
            // NotLiquidatable races are expected; stay quiet unless verbose
          }
        } else if (p.status === S.Closed || p.status === S.Liquidated || p.status === S.Cancelled) {
          finalized.add(i.toString()); // never re-read a terminal position
          seenClosed.add(p.id.toString());
        }
      }
    } catch (e) {
      console.error("loop error:", (e as Error).message);
    } finally {
      setTimeout(runLoop, POLL_MS);
    }
  };
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
