import { ethers } from "hardhat";

/** Deploy the FCC adapter. The vault is repointed separately, so deploying is
 *  inert until setExecutor is called — and reversible in one transaction. */
async function main() {
  const VAULT = "0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd";
  const agent = process.env.AGENT_ADDRESS!;
  // Flare's FlareTeeManager diamond, asked per call which enclaves it currently
  // attests for our extension. Not a stored address: a TEE key does not survive
  // a restart, so anything pinned here would go stale on its own.
  const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
  const EXTENSION_ID = 66154;
  if (!agent) throw new Error("set AGENT_ADDRESS (the current enclave executor)");

  const F = await ethers.getContractFactory("TorchTeeExecutor");
  const c = await F.deploy(VAULT, agent, TEE_MANAGER, EXTENSION_ID);
  await c.waitForDeployment();
  console.log("TorchTeeExecutor:", await c.getAddress());
  console.log("  vault    ", VAULT);
  console.log("  agent    ", agent);
  console.log("  registry ", TEE_MANAGER, "ext", EXTENSION_ID);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
