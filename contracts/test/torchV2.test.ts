import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const XRP_FEED = "0x015852502f55534400000000000000000000000000";
const BTC_FEED = "0x014254432f55534400000000000000000000000000";
const XRP = ethers.encodeBytes32String("XRP");
const BTC = ethers.encodeBytes32String("BTC");

const P = (n: number) => BigInt(Math.round(n * 1e6)); // 6dp helper
const FX = (n: number) => BigInt(Math.round(n * 1e6)); // FXRP units (6dp)

describe("TorchVaultV2", () => {
  async function fixture() {
    const [owner, executor, alice, treasury] = await ethers.getSigners();

    const fxrp = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockFtsoV2")).deploy();
    await oracle.setPrice(XRP_FEED, P(2.5)); // 1 XRP = 2.50 USD
    await oracle.setPrice(BTC_FEED, P(100_000));

    const vault = await (
      await ethers.getContractFactory("TorchVaultV2")
    ).deploy(
      await fxrp.getAddress(),
      await oracle.getAddress(),
      XRP_FEED,
      executor.address,
      treasury.address
    );
    await vault.listMarket(XRP, XRP_FEED, 100);
    await vault.listMarket(BTC, BTC_FEED, 100);

    await fxrp.connect(alice).faucet();
    await fxrp.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);

    await fxrp.mint(owner.address, 50_000n * 10n ** 6n);
    await fxrp.approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.fundInsurance(50_000n * 10n ** 6n);

    return { vault, fxrp, oracle, owner, executor, alice, treasury };
  }

  /** deposit + open a 2x BTC long with 100 FXRP margin, filled at the mark */
  async function openLong(f: Awaited<ReturnType<typeof fixture>>, marginFxrp = FX(100)) {
    const { vault, executor, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, marginFxrp, 20);
    const id = (await vault.positionsCount()) - 1n;
    await vault.connect(executor).confirmFill(id, P(100_000), 1n);
    return id;
  }

  // ------------------------------------------------------------- triggers

  it("lets the owner set triggers and rejects inverted ones", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice, executor } = f;
    const id = await openLong(f);

    await expect(vault.connect(alice).setTriggers(id, P(95_000), P(110_000)))
      .to.emit(vault, "TriggersUpdated")
      .withArgs(id, P(95_000), P(110_000));

    // long with stop above take-profit is inverted
    await expect(
      vault.connect(alice).setTriggers(id, P(111_000), P(110_000))
    ).to.be.revertedWithCustomError(vault, "BadStatus");

    // only the position owner may set triggers
    await expect(
      vault.connect(executor).setTriggers(id, P(95_000), 0)
    ).to.be.revertedWithCustomError(vault, "NotPositionOwner");
  });

  it("refuses an executor trigger-close when no trigger was crossed", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice, executor } = f;
    const id = await openLong(f);
    await vault.connect(alice).setTriggers(id, P(95_000), P(110_000));

    // FTSO still at 100k: neither side crossed
    await expect(
      vault.connect(executor).executeTrigger(id, P(100_000))
    ).to.be.revertedWithCustomError(vault, "TriggerNotHit");
  });

  it("settles a crossed stop-loss, re-verified against FTSO on-chain", async () => {
    const f = await loadFixture(fixture);
    const { vault, oracle, alice, executor } = f;
    const id = await openLong(f);
    await vault.connect(alice).setTriggers(id, P(95_000), 0);

    await oracle.setPrice(BTC_FEED, P(94_500)); // stop crossed
    await expect(vault.connect(executor).executeTrigger(id, P(94_500)))
      .to.emit(vault, "TriggerExecuted")
      .withArgs(id, true, P(94_500));

    const p = await vault.getPosition(id);
    expect(Number(p.status)).to.equal(4); // Closed
    expect(p.exitPrice6).to.equal(P(94_500));
    expect(p.pnlFxrp).to.be.lessThan(0n);
  });

  it("settles a crossed take-profit for a short", async () => {
    const f = await loadFixture(fixture);
    const { vault, oracle, alice, executor } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, false, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    await f.vault.connect(executor).confirmFill(id, P(100_000), 1n);

    await vault.connect(alice).setTriggers(id, 0, P(90_000)); // short: tp below
    await oracle.setPrice(BTC_FEED, P(89_000));
    await expect(vault.connect(executor).executeTrigger(id, P(89_100)))
      .to.emit(vault, "TriggerExecuted")
      .withArgs(id, false, P(89_100));
    const p = await vault.getPosition(id);
    expect(p.pnlFxrp).to.be.greaterThan(0n);
  });

  // ----------------------------------------------------------------- caps

  it("enforces the per-position notional cap at request time", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice } = f;
    await vault.setCaps(P(400), 0); // max $400 per position
    await vault.connect(alice).deposit(FX(1_000));
    // 100 FXRP * $2.50 * 2x = $500 notional > $400 cap
    await expect(
      vault.connect(alice).openPosition(BTC, true, FX(100), 20)
    ).to.be.revertedWithCustomError(vault, "NotionalCapExceeded");
    // $250 * 1x passes
    await vault.connect(alice).openPosition(BTC, true, FX(100), 10);
  });

  it("enforces the global open-notional cap at fill time and releases on settle", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice, executor } = f;
    await vault.setCaps(0, P(600)); // max $600 open across the book
    await vault.connect(alice).deposit(FX(1_000));

    await vault.connect(alice).openPosition(BTC, true, FX(100), 20); // $500
    const a = (await vault.positionsCount()) - 1n;
    await vault.connect(executor).confirmFill(a, P(100_000), 1n);
    expect(await vault.openNotionalUsd6()).to.equal(P(500));

    await vault.connect(alice).openPosition(BTC, true, FX(100), 20); // +$500 > $600
    const b = (await vault.positionsCount()) - 1n;
    await expect(
      vault.connect(executor).confirmFill(b, P(100_000), 2n)
    ).to.be.revertedWithCustomError(vault, "NotionalCapExceeded");

    // settle the first: notional releases, second can now fill
    await vault.connect(alice).requestClose(a);
    await vault.connect(executor).confirmClose(a, P(100_000));
    expect(await vault.openNotionalUsd6()).to.equal(0n);
    await vault.connect(executor).confirmFill(b, P(100_000), 2n);
  });

  // ------------------------------------------------- settlement economics

  it("routes the close fee to the treasury on a WINNING close", async () => {
    const f = await loadFixture(fixture);
    const { vault, fxrp, oracle, alice, executor, treasury } = f;
    const id = await openLong(f); // $500 notional at 100k
    const before = await fxrp.balanceOf(treasury.address);

    await oracle.setPrice(BTC_FEED, P(110_000)); // +10% -> winner
    await vault.connect(alice).requestClose(id);
    await vault.connect(executor).confirmClose(id, P(110_000));

    // close fee = 8bps of $500 = $0.40 = 0.16 FXRP at $2.50
    const got = (await fxrp.balanceOf(treasury.address)) - before;
    expect(got).to.equal(FX(0.16));
  });

  it("emits PayoutCapped when the insurance fund cannot cover full profit", async () => {
    const f = await loadFixture(fixture);
    const { vault, oracle, alice, executor, owner } = f;
    // drain the fund down to almost nothing first
    await vault.connect(owner).withdrawInsurance(FX(49_990), owner.address);
    const id = await openLong(f); // $500 notional

    await oracle.setPrice(BTC_FEED, P(150_000)); // +50% => profit $250 = 100 FXRP > remaining fund
    await vault.connect(alice).requestClose(id);
    await expect(vault.connect(executor).confirmClose(id, P(150_000))).to.emit(
      vault,
      "PayoutCapped"
    );
  });

  it("lets the owner sweep the insurance fund (v1 stranded it)", async () => {
    const f = await loadFixture(fixture);
    const { vault, fxrp, owner } = f;
    const before = await fxrp.balanceOf(owner.address);
    await expect(vault.withdrawInsurance(FX(1_000), owner.address))
      .to.emit(vault, "InsuranceWithdrawn")
      .withArgs(owner.address, FX(1_000));
    expect((await fxrp.balanceOf(owner.address)) - before).to.equal(FX(1_000));
    expect(await vault.insuranceFund()).to.equal(FX(49_000));
    await expect(
      vault.withdrawInsurance(FX(1_000_000), owner.address)
    ).to.be.revertedWithCustomError(vault, "InsufficientMargin");
  });

  it("conserves FXRP across a full winner settle", async () => {
    const f = await loadFixture(fixture);
    const { vault, fxrp, oracle, alice, executor } = f;
    const vaultAddr = await vault.getAddress();
    const id = await openLong(f);
    const vaultBefore = await fxrp.balanceOf(vaultAddr);
    const fundBefore = await vault.insuranceFund();

    await oracle.setPrice(BTC_FEED, P(110_000));
    await vault.connect(alice).requestClose(id);
    await vault.connect(executor).confirmClose(id, P(110_000));

    // payout stayed in freeMargin (still inside the vault); only the fee left
    const vaultAfter = await fxrp.balanceOf(vaultAddr);
    expect(vaultBefore - vaultAfter).to.equal(FX(0.16)); // fee to treasury
    // fund paid the full profit: $50 = 20 FXRP
    expect(fundBefore - (await vault.insuranceFund())).to.equal(FX(20));
  });
});
