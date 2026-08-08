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

  // The consumer binds attestations to vault positions, so it needs the vault.
  const depFile = path.join(__dirname, "..", "..", "web", "src", "generated", "deployments.json");
  const { vault, mode } = JSON.parse(fs.readFileSync(depFile, "utf8"));
  if (mode !== "coston2") {
    throw new Error(
      `deployments.json holds a "${mode}" deployment — deploying a Coston2 consumer bound to it would brick attestFillForPosition. Run deploy:coston2 first.`
    );
  }
  console.log("vault:", vault);

  const Factory = await ethers.getContractFactory("TorchFdcConsumer");
  const c = await Factory.deploy(vault);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("TorchFdcConsumer:", addr);

  // Record it alongside the generated deployment config for the script to read.
  // Receipt fields are deliberately NOT carried over: they belong to the old
  // consumer and would link to proofs this one does not hold. But dropping
  // them silently once shipped a `/tx/undefined` link on the verify page, so
  // say it loudly — the UI now degrades gracefully, and the receipts come back
  // on the next attestation (the enclave auto-attests every venue fill).
  const file = path.join(__dirname, "..", "..", "web", "src", "generated", "fdc.json");
  const had = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.writeFileSync(file, JSON.stringify({ fdcConsumer: addr, network: "coston2", vault }, null, 2));
  console.log("wrote", file);
  if (had.attestTx || had.positionAttest) {
    console.log(
      "\n  NOTE: receipt links for the previous consumer were dropped (they point at\n" +
        "  the retired contract). The verify page hides the proof links until this\n" +
        "  consumer has a receipt — repopulate with `npm run fdc:attest -w contracts`\n" +
        "  or by pasting an enclave-run attestation tx into fdc.json.\n"
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
