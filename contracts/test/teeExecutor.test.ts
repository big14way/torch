import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

/**
 * The adapter's whole job is to narrow what can reach the live vault: the entry
 * price must carry an enclave signature, everything else stays with the agent.
 * These tests pin both halves, plus the replay guard.
 */
describe("TorchTeeExecutor", () => {
  const ID = 7n;
  const PRICE6 = 64_863_000_000n;
  const OID = 57497722789n;

  async function fixture() {
    const [owner, agent, stranger] = await ethers.getSigners();
    // A throwaway key stands in for the enclave's signing key.
    const tee = ethers.Wallet.createRandom();

    const Vault = await ethers.getContractFactory("MockVaultSink");
    const vault = await Vault.deploy();
    await vault.waitForDeployment();

    const Adapter = await ethers.getContractFactory("TorchTeeExecutor");
    const adapter = await Adapter.deploy(await vault.getAddress(), agent.address, tee.address);
    await adapter.waitForDeployment();

    const sign = async (id: bigint, price: bigint, oid: bigint, signer = tee) => {
      const digest = await adapter.fillDigest(id, price, oid);
      return signer.signMessage(ethers.getBytes(digest));
    };

    return { adapter, vault, owner, agent, stranger, tee, sign };
  }

  it("accepts a fill the enclave signed, and passes it to the vault", async () => {
    const { adapter, vault, agent, sign } = await loadFixture(fixture);
    await adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID));
    expect(await vault.lastId()).to.equal(ID);
    expect(await vault.lastEntryPrice6()).to.equal(PRICE6);
    expect(await vault.lastOid()).to.equal(OID);
  });

  it("rejects a price the enclave did not sign — the operator cannot substitute a number", async () => {
    const { adapter, agent, sign } = await loadFixture(fixture);
    const sig = await sign(ID, PRICE6, OID);
    // same signature, better price for the house
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6 - 500_000_000n, OID, sig)
    ).to.be.revertedWithCustomError(adapter, "BadSignature");
  });

  it("rejects a signature from anyone other than the registered attestor", async () => {
    const { adapter, agent, sign } = await loadFixture(fixture);
    const impostor = ethers.Wallet.createRandom();
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID, impostor))
    ).to.be.revertedWithCustomError(adapter, "BadSignature");
  });

  it("will not replay one attestation onto a second position", async () => {
    const { adapter, agent, sign } = await loadFixture(fixture);
    await adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID));
    await expect(
      adapter.connect(agent).confirmFillAttested(ID + 1n, PRICE6, OID, await sign(ID + 1n, PRICE6, OID))
    ).to.be.revertedWithCustomError(adapter, "OidAlreadyUsed");
  });

  it("only the agent may relay, even with a valid signature", async () => {
    const { adapter, stranger, sign } = await loadFixture(fixture);
    await expect(
      adapter.connect(stranger).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID))
    ).to.be.revertedWithCustomError(adapter, "NotAgent");
  });

  it("forwards the non-price paths from the agent, unchanged", async () => {
    const { adapter, vault, agent } = await loadFixture(fixture);
    await adapter.connect(agent).acceptRequest(ID);
    await adapter.connect(agent).confirmClose(ID, PRICE6);
    await adapter.connect(agent).executeTrigger(ID, PRICE6);
    await adapter.connect(agent).liquidate(ID, PRICE6);
    expect(await vault.calls()).to.equal(4n);
  });

  it("blocks the non-price paths from anyone else", async () => {
    const { adapter, stranger } = await loadFixture(fixture);
    await expect(adapter.connect(stranger).liquidate(ID, PRICE6)).to.be.revertedWithCustomError(
      adapter,
      "NotAgent"
    );
  });

  it("refuses to confirm at all until an attestor is set", async () => {
    const { adapter, owner, agent, sign } = await loadFixture(fixture);
    const sig = await sign(ID, PRICE6, OID);
    await adapter.connect(owner).setTeeAttestor(ethers.ZeroAddress);
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, sig)
    ).to.be.revertedWithCustomError(adapter, "BadSignature");
  });
});
