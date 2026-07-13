import { ethers } from "hardhat";

/**
 * List new markets on the live vault (owner-only, no redeploy). Feeds were
 * verified live on Coston2 FTSOv2 before listing. Keep this in sync with
 * web/agent generated deployments.json and the agent's HL_COIN map — the
 * enclave must run an image that knows these keys BEFORE they are listed,
 * or fills for the new markets stall.
 *   npm run list:markets -w contracts
 */
const NEW = ["HYPE", "SOL", "DOGE"];
const MAX_LEV_X10 = 100; // 10x, same as existing markets

const b32 = (s: string) => ethers.encodeBytes32String(s);
const feed = (s: string) =>
  "0x" + ("01" + Buffer.from(`${s}/USD`, "ascii").toString("hex")).padEnd(42, "0");

async function main() {
  const vault = await ethers.getContractAt(
    "TorchVault",
    "0x7fC640Bd0e635a6AFc3B437e80f0DE192f6FA0BA"
  );
  const reader = await ethers.getContractAt(
    "FtsoV2Reader",
    "0xe98BEc67F44993c3a9f479500a23f26ca05BcFc5"
  );
  for (const key of NEW) {
    // refuse to list a market whose feed does not read live
    const [px] = await reader.getPrice(feed(key));
    console.log(`${key}: feed live at $${ethers.formatUnits(px, 6)}`);
    const tx = await vault.listMarket(b32(key), feed(key), MAX_LEV_X10);
    await tx.wait();
    console.log(`${key}: listed (10x max), tx ${tx.hash}`);
  }
  const all = await vault.listMarkets();
  console.log("markets on vault:", all.map((m: string) => ethers.decodeBytes32String(m)).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
