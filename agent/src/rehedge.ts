/**
 * Bring the Hyperliquid book back in line with the vault's open positions.
 *
 * A week of duplicate orders (see findFillByCloid) left the house carrying BTC
 * it never intended to hold: +0.01655 BTC long against a vault whose open
 * positions net to $27 SHORT. That gap is directional risk the insurance fund
 * did not choose, so it gets closed rather than carried.
 *
 * Reads the target from the chain, never from a typed-in number. Prints the
 * plan and requires APPLY=1 to place anything.
 *
 *   npx tsx src/rehedge.ts          # dry run
 *   APPLY=1 npx tsx src/rehedge.ts  # execute
 */
import "dotenv/config";
import { JsonRpcProvider, Contract } from "ethers";
import { HyperliquidTestnet, HL_MASTER_ACCOUNT } from "./exchange.js";

const RPC = process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc";
const VAULT = "0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd";
const HL_API = process.env.HL_API_URL || "https://api.hyperliquid-testnet.xyz";
// Markets Hyperliquid testnet actually lists. XRP is not one, so Torch fills it
// at the FTSO mark and it is unhedged by design — excluding it here keeps this
// from "correcting" a gap that is not a gap.
const HEDGED = new Set(["BTC", "ETH", "SOL", "DOGE", "HYPE"]);
const TOLERANCE_USD = 5;

const ABI = [
  "function positionsCount() view returns (uint256)",
  "function getPosition(uint256) view returns (tuple(uint256 id,address owner,bytes32 market,bool isLong,uint256 marginFxrp,uint256 sizeUsd6,uint256 entryPrice6,uint256 exitPrice6,int256 pnlFxrp,uint64 hlOid,uint8 status,uint40 openedAt,uint40 closedAt))",
];

async function main() {
  const provider = new JsonRpcProvider(RPC);
  const vault = new Contract(VAULT, ABI, provider);
  const n = Number(await vault.positionsCount());

  // What the book SHOULD hold, in USD, per market.
  const target: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const p = await vault.getPosition(i);
    if (Number(p.status) !== 2) continue; // Open only
    const market = Buffer.from(p.market.slice(2), "hex").toString().replace(/\0+$/, "");
    if (!HEDGED.has(market)) continue;
    const usd = Number(p.sizeUsd6) / 1e6;
    target[market] = (target[market] ?? 0) + (p.isLong ? usd : -usd);
  }

  const res = await fetch(`${HL_API}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "clearinghouseState", user: HL_MASTER_ACCOUNT }),
  });
  const state = (await res.json()) as any;
  const actual: Record<string, { szi: number; px: number }> = {};
  for (const a of state.assetPositions ?? []) {
    const q = a.position;
    actual[q.coin] = { szi: parseFloat(q.szi), px: parseFloat(q.entryPx) };
  }

  const ex = new HyperliquidTestnet(HL_API, process.env.HL_PRIVATE_KEY || "");
  await ex.assertAccountReadable();

  const markets = new Set([...Object.keys(target), ...Object.keys(actual).filter((m) => HEDGED.has(m))]);
  let acted = false;

  for (const market of markets) {
    const wantUsd = target[market] ?? 0;
    const have = actual[market];
    const px = have?.px ?? 0;
    if (!px) {
      console.log(`${market}: no venue position and no price; skipping`);
      continue;
    }
    const haveUsd = (have?.szi ?? 0) * px;
    const deltaUsd = wantUsd - haveUsd;

    console.log(
      `${market}: vault wants ${wantUsd.toFixed(2)} USD, venue holds ${haveUsd.toFixed(2)} USD ` +
        `(szi ${have?.szi ?? 0}) -> delta ${deltaUsd.toFixed(2)} USD`
    );
    if (Math.abs(deltaUsd) < TOLERANCE_USD) {
      console.log(`  within $${TOLERANCE_USD} tolerance; leaving alone`);
      continue;
    }

    // Reduce toward the target. Only ever shrink an over-large position here;
    // opening fresh exposure is the agent's job, not a cleanup script's.
    const reduceUsd = Math.min(Math.abs(deltaUsd), Math.abs(haveUsd));
    if (reduceUsd < 10) {
      console.log(`  reduction ${reduceUsd.toFixed(2)} USD is under the venue minimum; leaving alone`);
      continue;
    }
    const sizeUsd6 = BigInt(Math.floor(reduceUsd * 1e6));
    const wasLong = (have?.szi ?? 0) > 0;
    console.log(`  PLAN: reduce the ${wasLong ? "long" : "short"} by ${reduceUsd.toFixed(2)} USD`);

    if (process.env.APPLY === "1") {
      const fill = await ex.close(market, wasLong, sizeUsd6);
      console.log(`  DONE: filled at ${Number(fill.price6) / 1e6}, sz ${fill.szFilled}`);
      acted = true;
    }
  }

  if (process.env.APPLY !== "1") console.log("\nDRY RUN. Re-run with APPLY=1 to execute.");
  else if (!acted) console.log("\nNothing needed doing.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
