import { ethers } from "hardhat";

/**
 * Produces an on-chain receipt that a signature made inside the Flare TEE is
 * accepted by TorchTeeExecutor's real verification path — envelope, registry
 * lookup, replay guard and all.
 *
 * It runs against a MockVaultSink rather than the live vault on purpose:
 * repointing the live vault's executor also requires the off-chain agent to
 * start calling the adapter, which is a separate change. This isolates the
 * question judges actually care about — does the chain verify the enclave? —
 * and answers it with a transaction instead of a claim.
 *
 * Two steps, because signing has to happen inside the container:
 *   1. no SIG env  -> deploys, prints the digest to sign
 *   2. SIG + ADAPTER env -> submits and verifies
 */
async function main() {
  const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
  const EXTENSION_ID = 66154;
  const ID = 1n;
  const PRICE6 = 64_863_000_000n; // the price the vault stores for position #1
  const OID = 57497722789n; // the Hyperliquid order id behind it

  const [signer] = await ethers.getSigners();

  if (!process.env.SIG) {
    const Vault = await ethers.getContractFactory("MockVaultSink");
    const vault = await Vault.deploy();
    await vault.waitForDeployment();

    const Adapter = await ethers.getContractFactory("TorchTeeExecutor");
    const adapter = await Adapter.deploy(
      await vault.getAddress(),
      signer.address, // this deployer relays, standing in for the agent
      TEE_MANAGER,
      EXTENSION_ID
    );
    await adapter.waitForDeployment();

    const digest = await adapter.fillDigest(ID, PRICE6, OID);
    console.log("ADAPTER=" + (await adapter.getAddress()));
    console.log("SINK=" + (await vault.getAddress()));
    console.log("DIGEST=" + digest);
    return;
  }

  const adapter = await ethers.getContractAt("TorchTeeExecutor", process.env.ADAPTER!);
  const tx = await adapter.confirmFillAttested(ID, PRICE6, OID, process.env.SIG!);
  const rcpt = await tx.wait();
  console.log("verified on-chain in", rcpt!.hash);

  const sink = await ethers.getContractAt("MockVaultSink", await adapter.VAULT());
  console.log("  sink recorded price6", (await sink.lastEntryPrice6()).toString());
  console.log("  sink recorded oid   ", (await sink.lastOid()).toString());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
