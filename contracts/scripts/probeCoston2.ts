import { ethers } from "hardhat";

/**
 * Read-only pre-deploy probe of live Coston2. NO private key, gas, or state
 * change — pure view calls. Run BEFORE deploy:coston2 to validate the Flare
 * read path (README assumptions 1, 2, 3):
 *   1. FtsoV2 getFeedById works as a zero-fee STATIC VIEW (if it reverts /
 *      demands a fee, FtsoV2Reader must move to the payable path + FeeCalculator
 *      BEFORE we deploy — otherwise the on-chain price band breaks).
 *   2. The XRP/BTC/ETH bytes21 feed ids are correct.
 *   3. FlareContractRegistry resolves FtsoV2 at the canonical address.
 *
 *   npx hardhat run scripts/probeCoston2.ts --network coston2
 */
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const REGISTRY_ABI = ["function getContractAddressByName(string) view returns (address)"];
const FTSO_ABI = [
  "function getFeedById(bytes21) view returns (uint256 value, int8 decimals, uint64 timestamp)",
];

// bytes21 feed ids as written into generated/deployments.json (01 = crypto category).
const FEEDS = [
  { key: "XRP/USD", id: "0x015852502f55534400000000000000000000000000" },
  { key: "BTC/USD", id: "0x014254432f55534400000000000000000000000000" },
  { key: "ETH/USD", id: "0x014554482f55534400000000000000000000000000" },
];

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`network chainId ${net.chainId} (expect 114 = Coston2)\n`);

  const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, ethers.provider);
  const ftsoAddr: string = await registry.getContractAddressByName("FtsoV2");
  if (!ftsoAddr || ftsoAddr === ethers.ZeroAddress) {
    console.log("✗ registry did NOT resolve FtsoV2 (assumption 3 FAILED)");
    return;
  }
  console.log(`✓ assumption 3: registry resolved FtsoV2 = ${ftsoAddr}`);
  console.log(`  -> contracts/.env   FTSOV2_ADDRESS=${ftsoAddr}\n`);

  const ftso = new ethers.Contract(ftsoAddr, FTSO_ABI, ethers.provider);
  let allOk = true;
  for (const f of FEEDS) {
    try {
      const [value, decimals, timestamp] = await ftso.getFeedById(f.id);
      const px = Number(value) / 10 ** Number(decimals);
      console.log(`✓ ${f.key}  $${px}  (decimals ${decimals}, ts ${timestamp}) — static view OK`);
    } catch (e) {
      allOk = false;
      console.log(`✗ ${f.key}  FAILED: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  console.log(
    allOk
      ? "\nAll three read as zero-fee views — FtsoV2Reader's assumption holds on Coston2. Safe to deploy."
      : "\nAt least one read failed. Do NOT deploy until resolved (feed id wrong, or getFeedById is now payable → patch FtsoV2Reader first)."
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
