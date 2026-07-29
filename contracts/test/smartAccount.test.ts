import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const XRP_FEED = "0x015852502f55534400000000000000000000000000";
const BTC_FEED = "0x014254432f55534400000000000000000000000000";
const XRP = ethers.encodeBytes32String("XRP");
const BTC = ethers.encodeBytes32String("BTC");

const P = (n: number) => BigInt(Math.round(n * 1e6)); // 6dp helper
const FX = (n: number) => BigInt(n) * 10n ** 6n;

// The full user lifecycle driven by a smart-contract account instead of an
// EOA — the shape a Flare Smart Accounts PersonalAccount produces on Coston2.
// If these pass, the vault has no EOA assumptions and an XRPL-wallet user's
// FSA account can fund, trade, and withdraw unmodified.
describe("TorchVault x smart-contract account (FSA shape)", () => {
  async function fixture() {
    const [owner, executor, xrplUser, treasury] = await ethers.getSigners();

    const fxrp = await (await ethers.getContractFactory("MockFXRP")).deploy();
    const oracle = await (await ethers.getContractFactory("MockFtsoV2")).deploy();
    await oracle.setPrice(XRP_FEED, P(2.5));
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

    // insurance fund so profitable closes can pay out
    await fxrp.mint(owner.address, 50_000n * 10n ** 6n);
    await fxrp.approve(await vault.getAddress(), ethers.MaxUint256);
    await vault.fundInsurance(50_000n * 10n ** 6n);

    // the smart account, controlled by xrplUser, holding freshly "minted" FXRP
    // (in FSA terms: the PersonalAccount after a direct mint)
    const account = await (
      await ethers.getContractFactory("MockSmartAccount")
    ).deploy(xrplUser.address);
    await fxrp.mint(await account.getAddress(), FX(10_000));

    return { vault, fxrp, oracle, owner, executor, xrplUser, account, treasury };
  }

  // encodeFunctionData helpers for the batched calls
  const call = (target: string, data: string) => ({ target, value: 0n, data });

  it("funds margin with one atomic batch: approve + deposit", async () => {
    const { vault, fxrp, xrplUser, account } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();
    const acctAddr = await account.getAddress();

    await account.connect(xrplUser).executeUserOp([
      call(await fxrp.getAddress(), fxrp.interface.encodeFunctionData("approve", [vaultAddr, ethers.MaxUint256])),
      call(vaultAddr, vault.interface.encodeFunctionData("deposit", [FX(1_000)])),
    ]);

    expect(await vault.freeMargin(acctAddr)).to.equal(FX(1_000));
    expect(await fxrp.balanceOf(acctAddr)).to.equal(FX(9_000));
  });

  it("runs the whole lifecycle through the contract account: open, fill, close, withdraw", async () => {
    const { vault, fxrp, executor, xrplUser, account, oracle } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();
    const acctAddr = await account.getAddress();

    // the FSA one-signature shape: approve + deposit + openPosition in ONE batch
    await account.connect(xrplUser).executeUserOp([
      call(await fxrp.getAddress(), fxrp.interface.encodeFunctionData("approve", [vaultAddr, ethers.MaxUint256])),
      call(vaultAddr, vault.interface.encodeFunctionData("deposit", [FX(1_000)])),
      call(vaultAddr, vault.interface.encodeFunctionData("openPosition", [BTC, true, FX(400), 50])),
    ]);

    // position belongs to the ACCOUNT, and the TEE executor fills it as usual
    await vault.connect(executor).confirmFill(0, P(100_000), 42);
    let p = await vault.getPosition(0);
    expect(p.owner).to.equal(acctAddr);
    expect(p.status).to.equal(2); // Open

    // +1% -> profitable close, requested by the account
    await oracle.setPrice(BTC_FEED, P(101_000));
    await account
      .connect(xrplUser)
      .executeUserOp([call(vaultAddr, vault.interface.encodeFunctionData("requestClose", [0]))]);
    await vault.connect(executor).confirmClose(0, P(101_000));
    p = await vault.getPosition(0);
    expect(p.status).to.equal(4); // Closed
    expect(p.pnlFxrp).to.equal(FX(20));

    // withdraw everything back to the smart account's own balance
    const free = await vault.freeMargin(acctAddr);
    expect(free).to.be.greaterThan(FX(1_000)); // net profit landed
    await account
      .connect(xrplUser)
      .executeUserOp([call(vaultAddr, vault.interface.encodeFunctionData("withdraw", [free]))]);
    expect(await vault.freeMargin(acctAddr)).to.equal(0n);
    expect(await fxrp.balanceOf(acctAddr)).to.be.greaterThan(FX(10_000)); // whole trip profitable
  });

  it("keys margin and positions to the account address, not its controller", async () => {
    const { vault, fxrp, xrplUser, account } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();

    await account.connect(xrplUser).executeUserOp([
      call(await fxrp.getAddress(), fxrp.interface.encodeFunctionData("approve", [vaultAddr, ethers.MaxUint256])),
      call(vaultAddr, vault.interface.encodeFunctionData("deposit", [FX(500)])),
      call(vaultAddr, vault.interface.encodeFunctionData("openPosition", [XRP, true, FX(100), 30])),
    ]);

    expect(await vault.freeMargin(await account.getAddress())).to.equal(FX(400));
    expect(await vault.freeMargin(xrplUser.address)).to.equal(0n);

    // the controller EOA cannot touch the account's position directly
    await expect(vault.connect(xrplUser).cancelRequest(0)).to.be.revertedWithCustomError(
      vault,
      "NotPositionOwner"
    );

    // and a stranger cannot drive the smart account
    const [, , , , stranger] = await ethers.getSigners();
    await expect(
      account
        .connect(stranger)
        .executeUserOp([call(vaultAddr, vault.interface.encodeFunctionData("cancelRequest", [0]))])
    ).to.be.revertedWithCustomError(account, "NotController");
  });

  it("surfaces vault reverts through the batch atomically", async () => {
    const { vault, fxrp, xrplUser, account } = await loadFixture(fixture);
    const vaultAddr = await vault.getAddress();

    // deposit 100 then try to open with 200 margin: the whole batch reverts,
    // nothing sticks — same all-or-nothing behavior as one FSA instruction
    await expect(
      account.connect(xrplUser).executeUserOp([
        call(await fxrp.getAddress(), fxrp.interface.encodeFunctionData("approve", [vaultAddr, ethers.MaxUint256])),
        call(vaultAddr, vault.interface.encodeFunctionData("deposit", [FX(100)])),
        call(vaultAddr, vault.interface.encodeFunctionData("openPosition", [BTC, true, FX(200), 50])),
      ])
    ).to.be.revertedWithCustomError(account, "CallFailed");

    expect(await vault.freeMargin(await account.getAddress())).to.equal(0n);
    expect(await fxrp.balanceOf(await account.getAddress())).to.equal(FX(10_000));
  });
});
