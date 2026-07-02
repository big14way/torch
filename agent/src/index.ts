import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  hexToString,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import deployments from "./generated/deployments.json" with { type: "json" };
import vaultAbiJson from "./generated/TorchVault.abi.json" with { type: "json" };
import oracleAbiJson from "./generated/MockFtsoV2.abi.json" with { type: "json" };
import { MockExchange, HyperliquidTestnet, type Exchange } from "./exchange.js";
import { getAttestation } from "./tee.js";

const vaultAbi = vaultAbiJson as Abi;
const oracleAbi = oracleAbiJson as Abi;

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const MODE = (process.env.EXECUTION_MODE || "mock") as "mock" | "testnet";
const KEY = (process.env.EXECUTOR_PRIVATE_KEY ||
  // Hardhat account #1: public dev key, never holds value
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;

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

  const att = getAttestation();
  console.log("");
  console.log("  TORCH executor agent");
  console.log(`  chain      ${chainId} (${deployments.network})`);
  console.log(`  vault      ${deployments.vault}`);
  console.log(`  executor   ${account.address}`);
  console.log(`  mode       ${MODE}`);
  console.log(`  tee        ${att.mode} :: ${att.note}`);
  console.log("");

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
      process.env.HL_PRIVATE_KEY || ""
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
  console.log(`  Watching positions every ${POLL_MS / 1000}s...\n`);

  setInterval(async () => {
    try {
      const count = (await pub.readContract({
        ...vault,
        functionName: "positionsCount",
      })) as bigint;

      for (let i = 0n; i < count; i++) {
        const p = (await pub.readContract({
          ...vault,
          functionName: "getPosition",
          args: [i],
        })) as Position;
        const key = markKey(p.market);

        if (p.status === S.Requested) {
          try {
            const fill = await exchange.open(key, p.isLong, p.sizeUsd6);
            const hash = await wallet.writeContract({
              ...vault,
              functionName: "confirmFill",
              args: [p.id, fill.price6, fill.oid],
              gas: TX_GAS,
              chain: null,
            });
            log(p.id, `OPEN  ${key} ${p.isLong ? "long" : "short"} @ ${fmt6(fill.price6)} (${exchange.name}) tx ${hash.slice(0, 10)}`);
          } catch (e) {
            log(p.id, `open failed: ${(e as Error).message}`);
          }
        } else if (p.status === S.CloseRequested) {
          try {
            const fill = await exchange.close(key, p.isLong, p.sizeUsd6);
            const hash = await wallet.writeContract({
              ...vault,
              functionName: "confirmClose",
              args: [p.id, fill.price6],
              gas: TX_GAS,
              chain: null,
            });
            log(p.id, `CLOSE ${key} @ ${fmt6(fill.price6)} tx ${hash.slice(0, 10)}`);
          } catch (e) {
            log(p.id, `close failed: ${(e as Error).message}`);
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
        } else if ((p.status === S.Closed || p.status === S.Liquidated) && !seenClosed.has(p.id.toString())) {
          seenClosed.add(p.id.toString());
        }
      }
    } catch (e) {
      console.error("loop error:", (e as Error).message);
    }
  }, POLL_MS);
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
