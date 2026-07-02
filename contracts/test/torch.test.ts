import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const XRP_FEED = "0x015852502f55534400000000000000000000000000";
const BTC_FEED = "0x014254432f55534400000000000000000000000000";
const XRP = ethers.encodeBytes32String("XRP");
const BTC = ethers.encodeBytes32String("BTC");

const P = (n: number) => BigInt(Math.round(n * 1e6)); // 6dp helper

describe("TorchVault", () => {
  async function fixture() {
    const [owner, executor, alice, treasury] = await ethers.getSigners();

    const fxrp = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockFtsoV2")).deploy();
    await oracle.setPrice(XRP_FEED, P(2.5)); // 1 XRP = 2.50 USD
    await oracle.setPrice(BTC_FEED, P(100_000));

    const vault = await (
      await ethers.getContractFactory("TorchVault")
    ).deploy(
      await fxrp.getAddress(),
      await oracle.getAddress(),
      XRP_FEED,
      executor.address,
      treasury.address
    );
    await vault.listMarket(XRP, XRP_FEED, 100);
    await vault.listMarket(BTC, BTC_FEED, 100);

    // alice gets 10,000 tFXRP and approves
    await fxrp.connect(alice).faucet();
    await fxrp.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);

    // insurance fund: 50,000 tFXRP from owner
    await fxrp.mint(owner.address, 50_000n * 10n ** 6n);
    await fxrp.approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.fundInsurance(50_000n * 10n ** 6n);

    return { vault, fxrp, oracle, owner, executor, alice, treasury };
  }

  it("handles deposit and withdraw", async () => {
    const { vault, alice } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    expect(await vault.freeMargin(alice.address)).to.equal(1_000n * 10n ** 6n);
    await vault.connect(alice).withdraw(400n * 10n ** 6n);
    expect(await vault.freeMargin(alice.address)).to.equal(600n * 10n ** 6n);
    await expect(vault.connect(alice).withdraw(601n * 10n ** 6n)).to.be.revertedWithCustomError(
      vault,
      "InsufficientMargin"
    );
  });

  it("opens a position via executor fill and charges the open fee", async () => {
    const { vault, executor, alice, fxrp, treasury } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);

    // 400 FXRP margin at 5x. Margin = 1000 USD, size = 5000 USD (6dp).
    await vault.connect(alice).openPosition(BTC, true, 400n * 10n ** 6n, 50);
    const before = await fxrp.balanceOf(treasury.address);

    await vault.connect(executor).confirmFill(0, P(100_000), 777);
    const p = await vault.getPosition(0);
    expect(p.status).to.equal(2); // Open
    expect(p.sizeUsd6).to.equal(P(5_000));
    expect(p.entryPrice6).to.equal(P(100_000));
    expect(p.hlOid).to.equal(777);

    // open fee: 8bps of 5000 USD = 4 USD = 1.6 FXRP at 2.50
    const fee = await fxrp.balanceOf(treasury.address) - before;
    expect(fee).to.equal(1_600_000n);
  });

  it("rejects executor prices outside the FTSO band", async () => {
    const { vault, executor, alice } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    await vault.connect(alice).openPosition(BTC, true, 400n * 10n ** 6n, 50);
    // 2% above the 100,000 mark with a 1.5% band -> revert
    await expect(
      vault.connect(executor).confirmFill(0, P(102_000), 1)
    ).to.be.revertedWithCustomError(vault, "PriceOutOfBand");
  });

  it("settles a profitable long from the insurance fund", async () => {
    const { vault, executor, alice, oracle } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    await vault.connect(alice).openPosition(BTC, true, 400n * 10n ** 6n, 50);
    await vault.connect(executor).confirmFill(0, P(100_000), 1);

    // BTC +1%: 5000 USD size -> +50 USD pnl = +20 FXRP at 2.50
    await oracle.setPrice(BTC_FEED, P(101_000));
    await vault.connect(alice).requestClose(0);
    const insuranceBefore = await vault.insuranceFund();
    await vault.connect(executor).confirmClose(0, P(101_000));

    const p = await vault.getPosition(0);
    expect(p.status).to.equal(4); // Closed
    expect(p.pnlFxrp).to.equal(20n * 10n ** 6n);
    // insurance paid the profit portion
    expect(insuranceBefore - (await vault.insuranceFund())).to.be.greaterThan(0n);
    // payout = margin(after open fee) + pnl - close fee, back to free margin
    const free = await vault.freeMargin(alice.address);
    expect(free).to.be.greaterThan(600n * 10n ** 6n + 400n * 10n ** 6n); // net profit overall
  });

  it("settles a losing short and grows the insurance fund", async () => {
    const { vault, executor, alice, oracle } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    await vault.connect(alice).openPosition(BTC, false, 400n * 10n ** 6n, 50);
    await vault.connect(executor).confirmFill(0, P(100_000), 1);

    // BTC +1% hurts the short: -50 USD = -20 FXRP
    await oracle.setPrice(BTC_FEED, P(101_000));
    await vault.connect(alice).requestClose(0);
    const insuranceBefore = await vault.insuranceFund();
    await vault.connect(executor).confirmClose(0, P(101_000));

    const p = await vault.getPosition(0);
    expect(p.pnlFxrp).to.equal(-20n * 10n ** 6n);
    expect(await vault.insuranceFund()).to.be.greaterThan(insuranceBefore);
  });

  it("liquidates only when equity is below maintenance margin", async () => {
    const { vault, executor, alice, oracle } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    // 10x long: margin 1000 USD, size 10,000 USD, maintenance 5% = 500 USD.
    await vault.connect(alice).openPosition(BTC, true, 400n * 10n ** 6n, 100);
    await vault.connect(executor).confirmFill(0, P(100_000), 1);

    // -4% -> pnl = -400 USD, equity ~ 596 USD > 500: not liquidatable
    await oracle.setPrice(BTC_FEED, P(96_000));
    await expect(
      vault.connect(executor).liquidate(0, P(96_000))
    ).to.be.revertedWithCustomError(vault, "NotLiquidatable");

    // -6% -> pnl = -600 USD, equity ~ 396 USD < 500: liquidatable
    await oracle.setPrice(BTC_FEED, P(94_000));
    await vault.connect(executor).liquidate(0, P(94_000));
    const p = await vault.getPosition(0);
    expect(p.status).to.equal(5); // Liquidated
  });

  it("lets the user cancel an unfilled request", async () => {
    const { vault, alice } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    await vault.connect(alice).openPosition(XRP, true, 500n * 10n ** 6n, 30);
    expect(await vault.freeMargin(alice.address)).to.equal(500n * 10n ** 6n);
    await vault.connect(alice).cancelRequest(0);
    expect(await vault.freeMargin(alice.address)).to.equal(1_000n * 10n ** 6n);
  });

  it("blocks non-executor settlement", async () => {
    const { vault, alice } = await loadFixture(fixture);
    await vault.connect(alice).deposit(1_000n * 10n ** 6n);
    await vault.connect(alice).openPosition(BTC, true, 100n * 10n ** 6n, 20);
    await expect(vault.connect(alice).confirmFill(0, P(100_000), 1)).to.be.revertedWithCustomError(
      vault,
      "NotExecutor"
    );
  });
});
