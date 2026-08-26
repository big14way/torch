import { ethers } from "hardhat";

/**
 * Point the FCC adapter at a new agent address (owner-only, no redeploy).
 *
 * The vault's executor is the adapter (TorchTeeExecutor), and the adapter
 * decides which off-chain key may relay non-price operations. So moving the
 * agent between hosts is this one transaction: the vault is never touched, and
 * the price gate (an enclave signature Flare currently attests) is unaffected
 * either way.
 *
 * This is the counterpart to set:executor, which repoints the vault itself.
 * Use that one only to swap the adapter; use this one to swap the host.
 *
 *   AGENT_NEW=0x... npm run set:agent -w contracts
 */

const DEFAULT_ADAPTER = "0x321f606ed6cd64C2478F18053cFAb4ec1B0261de";

async function main() {
  const adapterAddr = process.env.ADAPTER || DEFAULT_ADAPTER;
  const newAgent = process.env.AGENT_NEW;
  if (!newAgent || !ethers.isAddress(newAgent)) {
    throw new Error("Set AGENT_NEW=0x<address of the new executor key>");
  }

  const [owner] = await ethers.getSigners();
  const adapter = await ethers.getContractAt("TorchTeeExecutor", adapterAddr, owner);

  const currentOwner = await adapter.owner();
  if (currentOwner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`signer ${owner.address} is not the adapter owner (${currentOwner})`);
  }

  console.log(`adapter   ${adapterAddr}`);
  console.log(`owner     ${owner.address}`);
  console.log(`current   ${await adapter.agent()}`);

  const tx = await adapter.setAgent(newAgent);
  console.log(`setAgent(${newAgent}) -> ${tx.hash}`);
  await tx.wait();
  console.log(`done. new agent: ${await adapter.agent()}`);

  // A newly authorized key with no gas cannot relay anything, and the failure
  // looks like a permissions problem rather than an empty wallet. Say so here.
  const bal = await ethers.provider.getBalance(newAgent);
  console.log(`gas       ${ethers.formatEther(bal)} C2FLR`);
  if (bal === 0n) console.log(`WARNING   fund ${newAgent} before it can send a transaction.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
