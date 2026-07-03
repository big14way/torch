import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Point the deployed TorchVault at a new executor address (owner-only, no
 * redeploy). Used to hand the executor role to the Confidential Space
 * enclave-generated key printed in the agent's boot log.
 *
 *   EXECUTOR_NEW=0x... npm run set:executor -w contracts
 */
async function main() {
  const file = path.join(__dirname, "..", "..", "web", "src", "generated", "deployments.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const newExec = process.env.EXECUTOR_NEW;
  if (!newExec || !ethers.isAddress(newExec)) {
    throw new Error("Set EXECUTOR_NEW=0x<enclave address>  (from the agent's boot log)");
  }
  const [owner] = await ethers.getSigners();
  const vault = await ethers.getContractAt("TorchVault", dep.vault, owner);
  console.log(`vault     ${dep.vault}`);
  console.log(`owner     ${owner.address}`);
  console.log(`current   ${await vault.executor()}`);
  const tx = await vault.setExecutor(newExec);
  console.log(`setExecutor(${newExec}) -> ${tx.hash}`);
  await tx.wait();
  console.log(`done. new executor: ${await vault.executor()}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
