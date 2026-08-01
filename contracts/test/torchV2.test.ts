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
    // settle at the oracle: 89_100 would be 0.1% worse for a short and is now
    // refused, which is the point of the no-worse-than-oracle rule.
    await expect(vault.connect(executor).executeTrigger(id, P(89_000)))
      .to.emit(vault, "TriggerExecuted")
      .withArgs(id, false, P(89_000));
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

  // ---------------------------------------------------------------------
  // Aug 1 audit regressions. Each of these fails against the pre-fix
  // contract, so they pin the behaviour rather than just describing it.
  // ---------------------------------------------------------------------

  it("refuses a settlement price shaded against the user, inside the band", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice } = f;
    const id = await openLong(f);
    await vault.connect(alice).requestClose(id);

    // 1% below the $100k oracle: inside the 1.5% band, but worse for a long.
    await expect(
      vault.connect(executor).confirmClose(id, P(99_000))
    ).to.be.revertedWithCustomError(vault, "PriceOutOfBand");

    // at the oracle, and better than it, both settle fine
    await expect(vault.connect(executor).confirmClose(id, P(100_500))).to.not.be.reverted;
  });

  it("refuses an entry price shaded against the user", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    // a long buying 1% ABOVE the oracle is worse for the user
    await expect(
      vault.connect(executor).confirmFill(id, P(101_000), 1n)
    ).to.be.revertedWithCustomError(vault, "PriceOutOfBand");
    await expect(vault.connect(executor).confirmFill(id, P(99_500), 1n)).to.not.be.reverted;
  });

  it("decides liquidation at the oracle, not at the executor's price", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, oracle } = f;
    const id = await openLong(f, FX(100)); // 2x long, $500 notional, entry 100k

    // Oracle says equity is still above maintenance. Executor tries to shade
    // 1.4% down (inside the band) to manufacture a liquidation.
    await oracle.setPrice(BTC_FEED, P(88_000));
    // shading down is refused outright now
    await expect(
      vault.connect(executor).liquidate(id, P(86_800))
    ).to.be.revertedWithCustomError(vault, "PriceOutOfBand");
    // and at the honest oracle price the position is simply not liquidatable
    await expect(
      vault.connect(executor).liquidate(id, P(88_000))
    ).to.be.revertedWithCustomError(vault, "NotLiquidatable");

    // Once the ORACLE itself crosses, the same call succeeds. (2x long on a
    // $500 notional with ~$249 of margin needs roughly a 50% drawdown.)
    await oracle.setPrice(BTC_FEED, P(50_000));
    await expect(vault.connect(executor).liquidate(id, P(50_000))).to.not.be.reverted;
    expect((await vault.getPosition(id)).status).to.equal(5); // Liquidated
  });

  it("still settles a stop-loss when price gaps well past the trigger", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice, oracle } = f;
    const id = await openLong(f);
    await vault.connect(alice).setTriggers(id, P(95_000), 0); // stop at 95k

    // gap straight through the stop to 90k. The honest exit is BELOW the
    // trigger; clamping to the trigger would have made this unclosable.
    await oracle.setPrice(BTC_FEED, P(90_000));
    await expect(vault.connect(executor).executeTrigger(id, P(90_000))).to.not.be.reverted;
    expect((await vault.getPosition(id)).status).to.equal(4); // Closed
  });

  it("lets a user exit while paused, but blocks new exposure", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice } = f;
    const id = await openLong(f);

    // queue a second position, then pause before it fills
    await vault.connect(alice).openPosition(BTC, true, FX(50), 20);
    const pending = (await vault.positionsCount()) - 1n;
    await vault.pause();

    // new risk is frozen
    await expect(vault.connect(alice).deposit(FX(10))).to.be.revertedWithCustomError(
      vault,
      "EnforcedPause"
    );
    await expect(
      vault.connect(executor).confirmFill(pending, P(100_000), 9n)
    ).to.be.revertedWithCustomError(vault, "EnforcedPause");

    // but the user is never trapped in an open position
    await expect(vault.connect(alice).setTriggers(id, P(90_000), 0)).to.not.be.reverted;
    await expect(vault.connect(alice).requestClose(id)).to.not.be.reverted;
    await expect(vault.connect(executor).confirmClose(id, P(100_000))).to.not.be.reverted;
  });

  it("treats a zero oracle price as stale instead of bricking the position", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice, oracle } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;

    // A zero feed used to pass _checkBand (diff == 0) and store entryPrice6 = 0,
    // after which every close divided by zero forever.
    const zeroOracle = await (await ethers.getContractFactory("MockZeroFtsoV2")).deploy();
    await vault.setOracle(await zeroOracle.getAddress());
    await expect(
      vault.connect(executor).confirmFill(id, 0n, 1n)
    ).to.be.revertedWithCustomError(vault, "StalePrice");
  });

  it("bounds the owner's parameter setters", async () => {
    const { vault } = await loadFixture(fixture);
    // a 100% band would make the oracle guarantee meaningless
    await expect(vault.setParams(10_000, 8, 8, 500, 100, 600)).to.be.revertedWithCustomError(
      vault,
      "BadLeverage"
    );
    await expect(vault.setParams(0, 8, 8, 500, 100, 600)).to.be.revertedWithCustomError(
      vault,
      "BadLeverage"
    );
    // disabling staleness entirely is no longer allowed
    await expect(vault.setParams(150, 8, 8, 500, 100, 0)).to.be.revertedWithCustomError(
      vault,
      "StalePrice"
    );
    await expect(vault.setParams(150, 8, 8, 500, 100, 600)).to.not.be.reverted;
  });

  it("lets a user retract their own close request", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice } = f;
    const id = await openLong(f);
    await vault.connect(alice).requestClose(id);
    expect((await vault.getPosition(id)).status).to.equal(3); // CloseRequested
    await vault.connect(alice).cancelCloseRequest(id);
    expect((await vault.getPosition(id)).status).to.equal(2); // back to Open
    expect(await vault.closeRequestedAt(id)).to.equal(0);
  });

  it("lets a user settle at the oracle when the executor never answers", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice, oracle } = f;
    const id = await openLong(f);
    await vault.connect(alice).requestClose(id);

    // executor is dead. Too early to self-close.
    await expect(vault.connect(alice).selfClose(id)).to.be.revertedWithCustomError(vault, "TooSoon");

    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 1]);
    // both feeds must be fresh: _settle reads the market feed for PnL and the
    // XRP feed to value margin, and maxPriceAge is 10 minutes
    await oracle.setPrice(BTC_FEED, P(101_000));
    await oracle.setPrice(XRP_FEED, P(2.5));
    const freeBefore = await vault.freeMargin(alice.address);
    await expect(vault.connect(alice).selfClose(id)).to.emit(vault, "SelfClosed");

    const p = await vault.getPosition(id);
    expect(p.status).to.equal(4); // Closed
    expect(p.exitPrice6).to.equal(P(101_000)); // settled AT the oracle
    expect(await vault.freeMargin(alice.address)).to.be.greaterThan(freeBefore);
  });

  it("will not let anyone else self-close your position", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice, owner } = f;
    const id = await openLong(f);
    await vault.connect(alice).requestClose(id);
    await ethers.provider.send("evm_increaseTime", [2 * 60 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(owner).selfClose(id)).to.be.revertedWithCustomError(
      vault,
      "NotPositionOwner"
    );
  });

  it("bounds the self-close delay so the trap cannot be recreated", async () => {
    const { vault } = await loadFixture(fixture);
    await expect(vault.setSelfCloseDelay(2 * 24 * 60 * 60)).to.be.revertedWithCustomError(
      vault,
      "TooSoon"
    );
    await expect(vault.setSelfCloseDelay(60)).to.be.revertedWithCustomError(vault, "TooSoon");
    await expect(vault.setSelfCloseDelay(30 * 60)).to.not.be.reverted;
  });

  it("keeps cancel free until the executor accepts the request", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    // nobody has hedged anything yet, so cancelling costs the operator nothing
    await expect(vault.connect(alice).cancelRequest(id)).to.not.be.reverted;
    expect((await vault.getPosition(id)).status).to.equal(6); // Cancelled
  });

  it("stops a user cancelling out from under a live hedge", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;

    await vault.connect(executor).acceptRequest(id); // executor goes to hedge
    await expect(vault.connect(alice).cancelRequest(id)).to.be.revertedWithCustomError(
      vault,
      "TooSoon"
    );

    // but the user is never stuck: the timeout always expires
    await ethers.provider.send("evm_increaseTime", [30 * 60 + 1]);
    await ethers.provider.send("evm_mine", []);
    await expect(vault.connect(alice).cancelRequest(id)).to.not.be.reverted;
  });

  it("clears the accept stamp once the fill lands", async () => {
    const f = await loadFixture(fixture);
    const { vault, executor, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    await vault.connect(executor).acceptRequest(id);
    expect(await vault.fillAcceptedAt(id)).to.be.greaterThan(0);
    await vault.connect(executor).confirmFill(id, P(100_000), 5n);
    expect(await vault.fillAcceptedAt(id)).to.equal(0);
  });

  it("only the executor can accept, and only a pending request", async () => {
    const f = await loadFixture(fixture);
    const { vault, alice } = f;
    await vault.connect(alice).deposit(FX(1_000));
    await vault.connect(alice).openPosition(BTC, true, FX(100), 20);
    const id = (await vault.positionsCount()) - 1n;
    await expect(vault.connect(alice).acceptRequest(id)).to.be.revertedWithCustomError(
      vault,
      "NotExecutor"
    );
    const open = await openLong(f);
    await expect(f.vault.connect(f.executor).acceptRequest(open)).to.be.revertedWithCustomError(
      vault,
      "BadStatus"
    );
  });

  it("bounds the accept timeout", async () => {
    const { vault } = await loadFixture(fixture);
    await expect(vault.setAcceptTimeout(60)).to.be.revertedWithCustomError(vault, "TooSoon");
    await expect(vault.setAcceptTimeout(3 * 60 * 60)).to.be.revertedWithCustomError(vault, "TooSoon");
    await expect(vault.setAcceptTimeout(10 * 60)).to.not.be.reverted;
  });
});
