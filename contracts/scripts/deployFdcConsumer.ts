import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy TorchFdcConsumer to Coston2. It verifies FDC Web2Json attestations of
 * Hyperliquid fills on-chain. Writes the address next to the vault deployment.
 *   npm run deploy:fdc -w contracts
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);
  const Factory = await ethers.getContractFactory("TorchFdcConsumer");
  const c = await Factory.deploy();
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("TorchFdcConsumer:", addr);

  // Record it alongside the generated deployment config for the script to read.
  const file = path.join(__dirname, "..", "..", "web", "src", "generated", "fdc.json");
  fs.writeFileSync(file, JSON.stringify({ fdcConsumer: addr, network: "coston2" }, null, 2));
  console.log("wrote", file);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
