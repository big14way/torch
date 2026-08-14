import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const XRP_FEED = "0x015852502f55534400000000000000000000000000";
const BTC_FEED = "0x014254432f55534400000000000000000000000000";
const XRP = ethers.encodeBytes32String("XRP");
const BTC = ethers.encodeBytes32String("BTC");
const P = (n: number) => BigInt(Math.round(n * 1e6));
const FX = (n: number) => BigInt(Math.round(n * 1e6));
const OID = 777n;

/**
 * v3's one change: profit is paid from the insurance fund, so profit is what
 * needs validator proof. A venue-routed winner settles at full value only once
 * FDC bound its entry fill, or after attestGrace. Losses, oracle-path fills and
 * everything within the honest flow settle exactly as v2 did.
 */
describe("TorchVaultV3 settlement gate", () => {
  async function fixture() {
    const [owner, executor, alice, treasury] = await ethers.getSigners();
    const fxrp = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockFtsoV2")).deploy();
    await oracle.setPrice(XRP_FEED, P(2.5));
    await oracle.setPrice(BTC_FEED, P(100_000));

    const vault = await (
      await ethers.getContractFactory("TorchVaultV3")
    ).deploy(await fxrp.getAddress(), await oracle.getAddress(), XRP_FEED, executor.address, treasury.address);
    await vault.listMarket(XRP, XRP_FEED, 100);
    await vault.listMarket(BTC, BTC_FEED, 100);

    const consumer = await (await ethers.getContractFactory("MockFdcConsumer")).deploy();
    await vault.setFdcConsumer(await consumer.getAddress());

    await fxrp.connect(alice).faucet();
    await fxrp.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await fxrp.mint(owner.address, 50_000n * 10n ** 6n);
    await fxrp.approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.fundInsurance(50_000n * 10n ** 6n);

    return { vault, consumer, fxrp, oracle, owner, executor, alice, treasury };
  }

  async function openVenueLong(f: Awaited<ReturnType<typeof fixture>>, oid = OID) {
    const { vault, executor, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    await vault.connect(executor).confirmFill(id, P(100_000), oid);
    return id;
  }

  async function requestClose(f: Awaited<ReturnType<typeof fixture>>, id: bigint) {
    await f.vault.connect(f.alice).requestClose(id);
  }

  it("blocks a profitable close until the validators bound the fill", async () => {
    const f = await loadFixture(fixture);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(101_000)); // long is now in profit
    await requestClose(f, id);
    await expect(
      f.vault.connect(f.executor).confirmClose(id, P(101_000))
    ).to.be.revertedWithCustomError(f.vault, "AwaitingAttestation");
  });

  it("settles the same close the moment the binding exists", async () => {
    const f = await loadFixture(fixture);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(101_000));
    await requestClose(f, id);
    await f.consumer.set(id, OID);
    await expect(f.vault.connect(f.executor).confirmClose(id, P(101_000))).to.emit(
      f.vault,
      "PositionClosed"
    );
  });

  it("a binding for a DIFFERENT oid does not open the gate", async () => {
    const f = await loadFixture(fixture);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(101_000));
    await requestClose(f, id);
    await f.consumer.set(id, OID + 1n); // validators proved some other fill
    await expect(
      f.vault.connect(f.executor).confirmClose(id, P(101_000))
    ).to.be.revertedWithCustomError(f.vault, "AwaitingAttestation");
  });

  it("after attestGrace an unattested winner settles, loudly", async () => {
    const f = await loadFixture(fixture);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(101_000));
    await requestClose(f, id);
    await time.increase(2 * 3600 + 60);
    await f.oracle.setPrice(BTC_FEED, P(101_000)); // refresh both feeds, as live ones would be
    await f.oracle.setPrice(XRP_FEED, P(2.5)); // _settle converts PnL through XRP/USD
    await expect(f.vault.connect(f.executor).confirmClose(id, P(101_000)))
      .to.emit(f.vault, "SettledUnattested")
      .withArgs(id, OID);
  });

  it("losers settle immediately — losses pay INTO the fund and need no proof", async () => {
    const f = await loadFixture(fixture);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(99_000)); // long is losing
    await requestClose(f, id);
    await expect(f.vault.connect(f.executor).confirmClose(id, P(99_000))).to.emit(
      f.vault,
      "PositionClosed"
    );
  });

  it("oracle-path fills (no venue, oid 0) are never gated", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice, oracle } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(XRP, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    await vault.connect(executor).confirmFill(id, P(2.5), 0n); // FTSO-mark fill
    await oracle.setPrice(XRP_FEED, P(2.6));
    await vault.connect(alice).requestClose(id);
    await expect(vault.connect(executor).confirmClose(id, P(2.6))).to.emit(
      vault,
      "PositionClosed"
    );
  });

  it("selfClose can never be trapped by the gate (grace <= selfCloseDelay)", async () => {
    const f = await loadFixture(fixture);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(101_000));
    await requestClose(f, id);
    const delay = await f.vault.selfCloseDelay();
    await time.increase(Number(delay) + 60);
    await f.oracle.setPrice(BTC_FEED, P(101_000)); // fresh feed after the jump
    await f.oracle.setPrice(XRP_FEED, P(2.5));
    // still unattested — but selfCloseDelay has passed, so attestGrace has too
    await expect(f.vault.connect(f.alice).selfClose(id)).to.emit(f.vault, "SelfClosed");
  });

  it("the grace bound is enforced: attestGrace cannot exceed selfCloseDelay", async () => {
    const f = await loadFixture(fixture);
    const delay = await f.vault.selfCloseDelay();
    await expect(
      f.vault.setAttestGrace(Number(delay) + 1)
    ).to.be.revertedWithCustomError(f.vault, "GraceExceedsSelfClose");
    await expect(f.vault.setAttestGrace(600)).to.emit(f.vault, "AttestGraceUpdated");
  });

  it("with no consumer bound the gate is off (deploy-order safety)", async () => {
    const f = await loadFixture(fixture);
    await f.vault.setFdcConsumer(ethers.ZeroAddress);
    const id = await openVenueLong(f);
    await f.oracle.setPrice(BTC_FEED, P(101_000));
    await requestClose(f, id);
    await expect(f.vault.connect(f.executor).confirmClose(id, P(101_000))).to.emit(
      f.vault,
      "PositionClosed"
    );
  });
});
