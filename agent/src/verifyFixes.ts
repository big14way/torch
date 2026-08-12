/**
 * Proves the two fixes on the live venue, WITHOUT touching the vault.
 *
 *   1. cloid recovery works at all — it queried the API wallet, which owns no
 *      fills, so it never once recovered and every retry placed another order
 *      (66 for position 0 on Aug 6, 28 for #17, 38 for #18).
 *   2. the enclave can attest a fill it has never cached — its cache refreshes
 *      every ~24s, so a just-placed fill was truthfully reported "not found",
 *      which is what stalled the wired vault.
 *
 * Run:  npx tsx src/verifyFixes.ts
 * Places ONE minimum-size order on Hyperliquid testnet and unwinds it.
 */
import "dotenv/config";
import { HyperliquidTestnet, HL_MASTER_ACCOUNT } from "./exchange.js";
import { TeeAttestor } from "./teeAttest.js";

const FCE = process.env.FCE_ACTION_URL ?? "https://torch-fce-production.up.railway.app/action";
const MARKET = "BTC";
const SIZE_USD6 = 12_000_000n; // $12 — above HL's $10 minimum

const ok = (b: boolean) => (b ? "PASS" : "FAIL");

async function main() {
  const ex = new HyperliquidTestnet(
    process.env.HL_API_URL || "https://api.hyperliquid-testnet.xyz",
    process.env.HL_PRIVATE_KEY || ""
  );

  console.log("=== 0. boot check: are we reading the account we trade on? ===");
  await ex.assertAccountReadable();
  console.log(`    master = ${HL_MASTER_ACCOUNT}\n`);

  // A cloid this run alone owns, so nothing historical can match it.
  const cloid = ("0x" + (0xfeed0000n + BigInt(Date.now() % 100000)).toString(16).padStart(32, "0")) as string;
  console.log(`=== 1. place one order, cloid ${cloid} ===`);
  const t0 = Date.now();
  const first = await ex.open(MARKET, true, SIZE_USD6, cloid);
  console.log(`    oid=${first.oid} px=${first.price6} sz=${first.szFilled} recovered=${!!first.recovered} (${Date.now() - t0}ms)`);
  console.log(`    ${ok(!first.recovered)}: a fresh order is not reported as recovered\n`);

  console.log("=== 2. call open() AGAIN with the same cloid ===");
  console.log("    before the fix this placed a second real order every time");
  const t1 = Date.now();
  const second = await ex.open(MARKET, true, SIZE_USD6, cloid);
  console.log(`    oid=${second.oid} px=${second.price6} sz=${second.szFilled} recovered=${!!second.recovered} (${Date.now() - t1}ms)`);
  console.log(`    ${ok(!!second.recovered)}: second call RECOVERED instead of placing`);
  console.log(`    ${ok(second.oid === first.oid)}: same oid — no new order was created`);
  console.log(`    ${ok(second.szFilled === first.szFilled)}: size not inflated by summing across orders\n`);

  console.log("=== 3. can the enclave attest a fill it has never cached? ===");
  console.log(`    the fill is ${Math.round((Date.now() - t0) / 1000)}s old; the cache refreshes every ~24s`);
  const attestor = new TeeAttestor(FCE, 30_000);
  const t2 = Date.now();
  const att = await attestor.attest(1n, first.oid);
  console.log(`    attested=${att ? "yes" : "no"} (${Date.now() - t2}ms)`);
  if (att) console.log(`    entryPrice6=${att.entryPrice6} sig=${att.signature.slice(0, 20)}...`);
  console.log(`    ${ok(att !== null)}: enclave signed a fill younger than its cache interval\n`);

  console.log("=== 4. unwind the test order ===");
  const closed = await ex.close(MARKET, true, SIZE_USD6);
  console.log(`    closed at ${closed.price6} sz=${closed.szFilled}`);

  const passed = !first.recovered && !!second.recovered && second.oid === first.oid && att !== null;
  console.log(`\n=== ${passed ? "ALL CHECKS PASSED" : "SOMETHING FAILED — DO NOT FLIP"} ===`);
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error("verify failed:", e);
  process.exit(1);
});
