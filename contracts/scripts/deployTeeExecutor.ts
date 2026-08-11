import { ethers } from "hardhat";

/** Deploy the FCC adapter. The vault is repointed separately, so deploying is
 *  inert until setExecutor is called — and reversible in one transaction. */
async function main() {
  const VAULT = "0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd";
  const agent = process.env.AGENT_ADDRESS!;
  const attestor = process.env.TEE_ATTESTOR || ethers.ZeroAddress;
  if (!agent) throw new Error("set AGENT_ADDRESS (the current enclave executor)");

  const F = await ethers.getContractFactory("TorchTeeExecutor");
  const c = await F.deploy(VAULT, agent, attestor);
  await c.waitForDeployment();
  console.log("TorchTeeExecutor:", await c.getAddress());
  console.log("  vault   ", VAULT);
  console.log("  agent   ", agent);
  console.log("  attestor", attestor);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
