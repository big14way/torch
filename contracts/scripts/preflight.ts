import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Pre-recording / pre-demo health check for the live Coston2 deployment.
 * Catches every known way the demo can break before the camera rolls:
 *   npm run preflight -w contracts
 *
 *  1. Enclave up + its executor key matches vault.executor() (a Phala restart
 *     regenerates the key; if mismatched, run setExecutor + fund the new key).
 *  2. Executor has gas to sign confirmFill.
 *  3. FTSO marks read live for every market.
 *  4. Insurance fund can cover a realistic demo profit.
 *  5. FDC consumer state (attested fills + position binding) intact.
 */
const STATUS_URL = "https://cc1525a5ca15c4c8ef2668e72bc888f5a0c3239a.dstack-pha-prod9.phala.network";

const ok = (m: string) => console.log("  \x1b[32mOK\x1b[0m ", m);
const warn = (m: string) => console.log("  \x1b[33mWARN\x1b[0m", m);
const fail = (m: string) => {
  console.log("  \x1b[31mFAIL\x1b[0m", m);
  failures++;
};
let failures = 0;

async function main() {
  const [signer] = await ethers.getSigners();
  const gen = (f: string) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "web", "src", "generated", f), "utf8"));
  const dep = gen("deployments.json");
  const fdc = gen("fdc.json");
  const vault = await ethers.getContractAt("TorchVault", dep.vault);

  console.log("\n== 1. TEE enclave ==");
  let enclaveExecutor: string | null = null;
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(15000) });
    const s: any = await res.json();
    enclaveExecutor = s.executor;
    ok(`status endpoint up: mode=${s.tee?.mode} executionMode=${s.executionMode}`);
  } catch (e) {
    fail(`status endpoint unreachable (enclave down or out of credit?): ${e}`);
  }
  const chainExecutor = await vault.executor();
  if (enclaveExecutor) {
    if (enclaveExecutor.toLowerCase() === chainExecutor.toLowerCase()) {
      ok(`executor matches vault.executor(): ${chainExecutor}`);
    } else {
      fail(
        `KEY ROTATED: enclave says ${enclaveExecutor} but vault.executor() is ${chainExecutor}. ` +
          `Fix: EXECUTOR_NEW=${enclaveExecutor} npm run set:executor -w contracts, then fund it with C2FLR.`
      );
    }
  }

  console.log("\n== 2. Gas balances ==");
  const execBal = await ethers.provider.getBalance(chainExecutor);
  const signerBal = await ethers.provider.getBalance(signer.address);
  (execBal >= ethers.parseEther("2") ? ok : fail)(
    `executor C2FLR: ${ethers.formatEther(execBal)} (needs >= 2 to confirm fills)`
  );
  (signerBal >= ethers.parseEther("1") ? ok : warn)(`deployer C2FLR: ${ethers.formatEther(signerBal)}`);

  console.log("\n== 3. FTSO marks ==");
  for (const m of dep.markets) {
    try {
      const px = await vault.markPrice6(m.id);
      (px > 0n ? ok : fail)(`${m.key}: $${(Number(px) / 1e6).toLocaleString()}`);
    } catch (e) {
      fail(`${m.key}: markPrice6 reverted: ${e}`);
    }
  }

  console.log("\n== 4. Insurance fund ==");
  const fund = await vault.insuranceFund();
  const fundF = Number(fund) / 1e6;
  (fund >= 25_000_000n ? ok : warn)(
    `insurance fund: ${fundF.toFixed(2)} FXRP` +
      (fund < 25_000_000n
        ? " — low. Claim FTestXRP from https://faucet.flare.network, approve the vault, then call fundInsurance so a winning demo close pays out visibly."
        : "")
  );

  console.log("\n== 5. FDC consumer ==");
  try {
    const consumer = await ethers.getContractAt("TorchFdcConsumer", fdc.fdcConsumer);
    const n = await consumer.attestedCount();
    (n > 0n ? ok : warn)(`attested fills: ${n}`);
    if (fdc.positionAttest) {
      const bound = await consumer.positionAttestedOid(BigInt(fdc.positionAttest.positionId));
      (bound > 0n ? ok : fail)(
        `position #${fdc.positionAttest.positionId} bound to Hyperliquid oid ${bound}`
      );
    }
  } catch (e) {
    fail(`consumer read failed: ${e}`);
  }

  console.log(failures === 0 ? "\nAll clear. Roll camera. 🔦" : `\n${failures} blocker(s) — fix before recording.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
