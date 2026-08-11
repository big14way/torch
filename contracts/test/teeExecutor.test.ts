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
  const EXT = 66154n; // Torch's Flare Compute Extension id

  async function fixture() {
    const [owner, agent, stranger] = await ethers.getSigners();
    // A throwaway key stands in for the enclave's signing key.
    const tee = ethers.Wallet.createRandom();

    const Vault = await ethers.getContractFactory("MockVaultSink");
    const vault = await Vault.deploy();
    await vault.waitForDeployment();

    // The adapter asks this registry, per call, whether a signer is attested.
    const Registry = await ethers.getContractFactory("MockTeeRegistry");
    const registry = await Registry.deploy();
    await registry.waitForDeployment();
    await registry.setActive(EXT, [tee.address]);

    const Adapter = await ethers.getContractFactory("TorchTeeExecutor");
    const adapter = await Adapter.deploy(
      await vault.getAddress(),
      agent.address,
      await registry.getAddress(),
      EXT
    );
    await adapter.waitForDeployment();

    const sign = async (id: bigint, price: bigint, oid: bigint, signer = tee) => {
      const digest = await adapter.fillDigest(id, price, oid);
      // Exactly what the TEE node does with the bytes it is handed: keccak
      // first, then the personal-sign envelope (which signMessage applies).
      return signer.signMessage(ethers.getBytes(ethers.keccak256(digest)));
    };

    return { adapter, vault, registry, owner, agent, stranger, tee, sign };
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

  it("rejects a signature from a key Flare does not attest", async () => {
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

  it("refuses to confirm at all while no machine is attested for the extension", async () => {
    const { adapter, registry, agent, sign } = await loadFixture(fixture);
    const sig = await sign(ID, PRICE6, OID);
    await registry.setActive(EXT, []);
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, sig)
    ).to.be.revertedWithCustomError(adapter, "BadSignature");
  });

  // The reason this contract reads the registry instead of storing an address.
  // Flare DevRel: "TEE key is not preserved during restart. That is the key
  // element of this." A pinned attestor would reject every honest fill from the
  // moment the enclave restarted, and unwedging it would need an owner tx.
  it("follows the enclave across a restart, with no owner action", async () => {
    const { adapter, vault, registry, agent, sign } = await loadFixture(fixture);
    const restarted = ethers.Wallet.createRandom(); // new process, new key

    // Before re-registration the new key is a stranger, even though it is the
    // one genuinely running.
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID, restarted))
    ).to.be.revertedWithCustomError(adapter, "BadSignature");

    await registry.setActive(EXT, [restarted.address]);

    await adapter
      .connect(agent)
      .confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID, restarted));
    expect(await vault.lastEntryPrice6()).to.equal(PRICE6);
  });

  it("stops trusting a key once Flare stops attesting it", async () => {
    const { adapter, registry, agent, sign } = await loadFixture(fixture);
    const replacement = ethers.Wallet.createRandom();
    await registry.setActive(EXT, [replacement.address]);
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID))
    ).to.be.revertedWithCustomError(adapter, "BadSignature");
  });

  it("will not accept a machine attested for somebody else's extension", async () => {
    const { adapter, registry, agent, sign } = await loadFixture(fixture);
    const other = ethers.Wallet.createRandom();
    await registry.setActive(EXT + 1n, [other.address]);
    await expect(
      adapter.connect(agent).confirmFillAttested(ID, PRICE6, OID, await sign(ID, PRICE6, OID, other))
    ).to.be.revertedWithCustomError(adapter, "BadSignature");
  });
});
