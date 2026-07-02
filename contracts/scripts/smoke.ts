import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * End-to-end smoke test. Run with the chain AND the agent already running:
 *   1. npm run chain      (terminal A)
 *   2. npm run deploy:local
 *   3. npm run agent      (terminal B)
 *   4. npm run smoke -w contracts   (terminal C)
 *
 * It plays a full user session: faucet, deposit, open a long, wait for the
 * TEE agent to fill it, request close, wait for settlement, print PnL.
 */
async function main() {
  const file = path.join(__dirname, "..", "..", "agent", "src", "generated", "deployments.json");
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const [, , user] = await ethers.getSigners(); // account #2 = fresh user

  const fxrp = await ethers.getContractAt("MockFXRP", dep.fxrp, user);
  const vault = await ethers.getContractAt("TorchVault", dep.vault, user);

  console.log(`user: ${user.address}`);
  await (await fxrp.faucet()).wait();
  await (await fxrp.approve(dep.vault, ethers.MaxUint256)).wait();
  await (await vault.deposit(2_000n * 10n ** 6n)).wait();
  console.log("deposited 2,000 tFXRP");

  const xrpId = ethers.encodeBytes32String("XRP");
  const tx = await vault.openPosition(xrpId, true, 500n * 10n ** 6n, 50); // 5x long
  await tx.wait();
  const id = (await vault.positionsCount()) - 1n;
  console.log(`requested position #${id} (5x long XRP, 500 FXRP margin)`);

  const status = async () => Number((await vault.getPosition(id)).status);
  await waitFor(async () => (await status()) === 2, "agent fill", 30_000);
  const opened = await vault.getPosition(id);
  console.log(`OPEN at $${Number(opened.entryPrice6) / 1e6} (hlOid ${opened.hlOid})`);

  await (await vault.requestClose(id)).wait();
  console.log("close requested");
  await waitFor(async () => (await status()) === 4 || (await status()) === 5, "settlement", 30_000);

  const done = await vault.getPosition(id);
  const pnl = Number(done.pnlFxrp) / 1e6;
  console.log(
    `SETTLED at $${Number(done.exitPrice6) / 1e6} | PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} FXRP`
  );
  console.log(`free margin now: ${Number(await vault.freeMargin(user.address)) / 1e6} tFXRP`);
  console.log("smoke test passed");
}

async function waitFor(cond: () => Promise<boolean>, label: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`timed out waiting for ${label}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
