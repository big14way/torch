import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Top up the vault's insurance fund that backs positive-PnL payouts.
 * Approves FXRP from the deployer wallet, then calls fundInsurance.
 *
 *   AMOUNT=50 npm run fund:insurance -w contracts   (FXRP, defaults to 50)
 */
async function main() {
  const file = path.join(__dirname, "..", "..", "web", "src", "generated", "deployments.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const amount = BigInt(Math.round(Number(process.env.AMOUNT ?? "50") * 1e6));
  const [signer] = await ethers.getSigners();
  const vault = await ethers.getContractAt("TorchVault", dep.vault, signer);
  const fxrp = await ethers.getContractAt("IERC20", dep.fxrp, signer);

  const balance = await fxrp.balanceOf(signer.address);
  console.log(`signer     ${signer.address}`);
  console.log(`balance    ${Number(balance) / 1e6} FXRP`);
  console.log(`fund now   ${Number(await vault.insuranceFund()) / 1e6} FXRP`);
  if (balance < amount) {
    throw new Error(
      `Not enough FXRP: need ${Number(amount) / 1e6}, have ${Number(balance) / 1e6}. ` +
        "Claim FTestXRP from https://faucet.flare.network or lower AMOUNT."
    );
  }

  const approveTx = await fxrp.approve(dep.vault, amount);
  console.log(`approve(${Number(amount) / 1e6} FXRP) -> ${approveTx.hash}`);
  await approveTx.wait();

  const fundTx = await vault.fundInsurance(amount);
  console.log(`fundInsurance -> ${fundTx.hash}`);
  await fundTx.wait();
  console.log(`done. fund now ${Number(await vault.insuranceFund()) / 1e6} FXRP`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
