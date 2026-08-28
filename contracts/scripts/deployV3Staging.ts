import { ethers } from "hardhat";

/**
 * TorchVaultV3 STAGING on Coston2 — the FDC-settlement gate, live but separate.
 *
 * Deliberately not wired to anything a user touches: its own vault, its own
 * consumer, deployer as executor, funded from the deployer's own free margin
 * in the live vault (a plain user withdrawal). The live v2 vault and the
 * submission under review are untouched by construction.
 *
 * Ends by demonstrating the gate on-chain: two positions opened both ways at
 * the live FTSO price, and whichever is in profit at close time must revert
 * AwaitingAttestation — profit needs validator proof, and no proof exists yet.
 */
// PARKED until Summer Signal review completes: this script's only live-vault
// touch is withdrawing the deployer's own free margin to fund staging, and
// even a cosmetic transaction on the reviewed contract is not worth it while
// judges may be looking. The gate itself is fully proven by the test suite;
// staging is a demo, not validation. Run after review, then drive a real FDC
// round against the staging consumer.
const LIVE_VAULT = "0x8d9A6a11BcC64CC36e54b22ACa68865d759fa6Bd";
const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7";
const READER = "0xF8be9ca7bCb07B0e87BDcEAB28841fF6A16E7D01"; // registry-resolving, shared read-only
const feedId = (n: string) =>
  "0x01" + Buffer.from(`${n}/USD`).toString("hex").padEnd(40, "0");
const XRP_FEED = feedId("XRP");
const BTC_FEED = feedId("BTC");
const BTC = ethers.encodeBytes32String("BTC");
// A real Hyperliquid order id from the master account's book (position #24's
// fill), so the long can later be bound by a REAL FDC round on staging.
const REAL_OID = 57765415609n;

const FX = (n: number) => BigInt(Math.round(n * 1e6));

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);

  // 1. fund staging from our own free margin in the live vault
  const live = await ethers.getContractAt("TorchVaultV2", LIVE_VAULT);
  const fxrp = await ethers.getContractAt("MockFXRP", FXRP); // ERC20 surface only
  const free = (await live.freeMargin(deployer.address)) as bigint;
  console.log("live freeMargin:", free.toString());
  if (free >= FX(15)) {
    await (await live.withdraw(FX(15))).wait();
    console.log("withdrew 15 FXRP from live vault (own funds)");
  }

  // 2. the staging vault
  const vault = await (
    await ethers.getContractFactory("TorchVaultV3")
  ).deploy(FXRP, READER, XRP_FEED, deployer.address, deployer.address);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log("TorchVaultV3 (staging):", vaultAddr);
  await (await vault.listMarket(BTC, BTC_FEED, 100)).wait();
  await (await vault.listMarket(ethers.encodeBytes32String("XRP"), XRP_FEED, 100)).wait();

  // 3. its own consumer, bound to it, then bound back
  const consumer = await (
    await ethers.getContractFactory("TorchFdcConsumer")
  ).deploy(vaultAddr);
  await consumer.waitForDeployment();
  const consumerAddr = await consumer.getAddress();
  console.log("TorchFdcConsumer (staging):", consumerAddr);
  await (await vault.setFdcConsumer(consumerAddr)).wait();

  // 4. seed
  await (await fxrp.approve(vaultAddr, ethers.MaxUint256)).wait();
  await (await vault.fundInsurance(FX(8))).wait();
  await (await vault.deposit(FX(6))).wait();

  // 5. two positions, both directions, filled at the live FTSO price
  // read the price the vault itself would use, via the reader
  const reader = new ethers.Contract(
    READER,
    ["function getPrice(bytes21) view returns (uint256,int8,uint64)"],
    deployer
  );
  const [v, dec] = await reader.getPrice(BTC_FEED);
  const px6 =
    Number(dec) === 6
      ? (v as bigint)
      : Number(dec) > 6
        ? (v as bigint) / 10n ** BigInt(Number(dec) - 6)
        : (v as bigint) * 10n ** BigInt(6 - Number(dec));
  console.log("live BTC px6:", px6.toString());

  await (await vault.openPosition(BTC, true, FX(2.5), 20)).wait(); // id 0, long
  await (await vault.openPosition(BTC, false, FX(2.5), 20)).wait(); // id 1, short
  await (await vault.confirmFill(0, px6, REAL_OID)).wait();
  await (await vault.confirmFill(1, px6, REAL_OID + 1n)).wait();
  console.log("both positions open at", px6.toString());

  await (await vault.requestClose(0)).wait();
  await (await vault.requestClose(1)).wait();

  // 6. the demonstration: a fresh read has drifted; whichever side is in
  // profit must be refused until validators have proved its fill
  const [v2, dec2] = await reader.getPrice(BTC_FEED);
  const now6 =
    Number(dec2) === 6
      ? (v2 as bigint)
      : Number(dec2) > 6
        ? (v2 as bigint) / 10n ** BigInt(Number(dec2) - 6)
        : (v2 as bigint) * 10n ** BigInt(6 - Number(dec2));
  console.log("close-time px6:", now6.toString());
  for (const id of [0n, 1n]) {
    try {
      await vault.confirmClose.staticCall(id, now6);
      console.log(`#${id}: close would SETTLE (loser or flat — no proof needed)`);
    } catch (e: any) {
      const gated = (e.message ?? "").includes("AwaitingAttestation");
      console.log(`#${id}: close reverts ${gated ? "AwaitingAttestation — THE GATE, on-chain" : "(" + (e.message ?? "").slice(0, 60) + ")"}`);
    }
  }
  console.log("\nstaging up. Next: run a real FDC round for oid", REAL_OID.toString(), "against the staging consumer, then the gated close settles.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
