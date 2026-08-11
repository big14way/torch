// Wait out v2 acceptTimeout on parked position #0, cancel it, rerun canary as #1.
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const env = fs.readFileSync("/Users/gwill/Developer/torch/contracts/.env", "utf8");
const PRIVATE_KEY = env.match(/^PRIVATE_KEY=(.+)$/m)[1].trim();
const abi = JSON.parse(fs.readFileSync("/Users/gwill/Developer/torch/agent/src/generated/TorchVault.abi.json", "utf8"));
const p = new ethers.JsonRpcProvider("https://coston2-api.flare.network/ext/C/rpc");
const w = new ethers.Wallet(PRIVATE_KEY, p);
const v = new ethers.Contract("0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd", abi, w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

const deadline = Date.now() + 45 * 60_000;

// Phase 1: cancel #0 once the accept timeout lapses (retry every 60s).
let cancelled = false;
while (Date.now() < deadline) {
  try {
    const tx = await v.cancelRequest(0);
    await tx.wait();
    log("cancelled #0, margin recovered. tx", tx.hash);
    cancelled = true;
    break;
  } catch (e) {
    log("cancel not yet unlocked, retrying in 60s");
    await sleep(60_000);
  }
}
if (!cancelled) { console.error("FAIL: could not cancel #0 within 45min"); process.exit(1); }

// Phase 2: canary as position #1 (cloid 0x...01, nonzero).
const tx = await v.openPosition(ethers.encodeBytes32String("BTC"), true, 5_000_000n, 30);
await tx.wait();
const id = Number(await v.positionsCount()) - 1;
log(`requested position #${id} (3x long BTC, 5 FXRP margin)`);
let opened = false;
for (let i = 0; i < 60; i++) {
  const pos = await v.getPosition(id);
  if (Number(pos.status) === 2) {
    log(`OPEN at $${ethers.formatUnits(pos.entryPrice6, 6)} hlOid ${pos.hlOid}`);
    if (pos.hlOid === 0n) log("WARNING: hlOid is 0 — fill did NOT route to the exchange");
    opened = true;
    break;
  }
  await sleep(3000);
}
if (!opened) { console.error("FAIL: fill timeout on #" + id); process.exit(1); }
await (await v.requestClose(id)).wait();
log("close requested");
for (let i = 0; i < 60; i++) {
  const pos = await v.getPosition(id);
  if (Number(pos.status) === 4) { log("SETTLED. Canary PASSED end to end."); process.exit(0); }
  await sleep(3000);
}
console.error("FAIL: close timeout on #" + id);
process.exit(1);
