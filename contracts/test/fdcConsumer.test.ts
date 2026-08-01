import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * The FDC consumer had zero test coverage, which is a problem because it is the
 * contract that backs Torch's central public claim: that Flare's validators,
 * not our word, establish a fill really happened. These tests pin the guards
 * that claim rests on, and equally pin the things it does NOT prove, so the
 * limits stay honest as the code changes.
 *
 * The Merkle/consensus check itself is stubbed (TestableFdcConsumer) because it
 * needs Flare's live FdcVerification; everything downstream of it is the real
 * production path.
 */

const BTC = ethers.encodeBytes32String("BTC");
const ETH = ethers.encodeBytes32String("ETH");

/** Read straight off the contract so the tests can never drift from the
 * constants they are meant to be pinning. */
type Pinned = {
  url: string;
  body: string;
  method: string;
  headers: string;
  query: string;
  abiSignature: string;
  latestJq: string;
};

const FILL_TUPLE = ["tuple(string,string,string,string,uint256,uint256)"];

type Fill = { coin: string; side: string; px: string; sz: string; oid: bigint; time: bigint };

function encodeFill(f: Fill): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(FILL_TUPLE, [
    [f.coin, f.side, f.px, f.sz, f.oid, f.time],
  ]);
}

/** The JQ the contract rebuilds for a position-bound attestation. */
function jqForOid(oid: bigint): string {
  return `map(select(.oid == ${oid})) | .[0] | {coin: .coin, side: .dir, px: .px, sz: .sz, oid: .oid, time: .time}`;
}

/** A proof shaped like IWeb2Json.Proof, with every pinned field correct unless
 * a test deliberately changes one. */
function makeProof(
  pinned: Pinned,
  opts: { jq: string; fill: Fill; overrides?: Record<string, string> }
) {
  const o = opts.overrides ?? {};
  return {
    merkleProof: [] as string[],
    data: {
      attestationType: ethers.encodeBytes32String("Web2Json"),
      sourceId: ethers.encodeBytes32String("PublicWeb2"),
      votingRound: 12345n,
      lowestUsedTimestamp: 0n,
      requestBody: {
        url: o.url ?? pinned.url,
        httpMethod: o.httpMethod ?? pinned.method,
        headers: o.headers ?? pinned.headers,
        queryParams: o.queryParams ?? pinned.query,
        body: o.body ?? pinned.body,
        postProcessJq: opts.jq,
        abiSignature: o.abiSignature ?? pinned.abiSignature,
      },
      responseBody: { abiEncodedData: encodeFill(opts.fill) },
    },
  };
}

describe("TorchFdcConsumer", () => {
  async function fixture() {
    const vault = await (await ethers.getContractFactory("MockVaultForFdc")).deploy();
    const consumer = await (
      await ethers.getContractFactory("TestableFdcConsumer")
    ).deploy(await vault.getAddress());
    // position 0: a BTC long backed by exchange order 777
    await vault.setPosition(0, BTC, true, 777);
    const pinned: Pinned = {
      url: await consumer.EXPECTED_URL(),
      body: await consumer.EXPECTED_BODY(),
      method: await consumer.EXPECTED_METHOD(),
      headers: await consumer.EXPECTED_HEADERS(),
      query: await consumer.EXPECTED_QUERY(),
      abiSignature: await consumer.EXPECTED_ABI_SIG(),
      latestJq: await consumer.EXPECTED_JQ(),
    };
    return { vault, consumer, pinned };
  }

  const btcLongFill = (oid = 777n): Fill => ({
    coin: "BTC",
    side: "Open Long",
    px: "100000.0",
    sz: "0.01",
    oid,
    time: 1_700_000_000_000n,
  });

  // ------------------------------------------------------------ what it proves

  it("binds a position to the exact exchange order the vault recorded", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill() }))
    )
      .to.emit(consumer, "PositionFillAttested")
      .withArgs(0, 777, "100000.0", "0.01", 12345);
    expect(await consumer.positionAttestedOid(0)).to.equal(777);
  });

  it("rejects a proof for a different order id than the position stored", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    // JQ selects 888 while the vault's position points at 777
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(888n), fill: btcLongFill(888n) }))
    ).to.be.revertedWith("FDC: transform not bound to position");
  });

  it("rejects a real fill of the wrong market", async () => {
    const { vault, consumer, pinned } = await loadFixture(fixture);
    await vault.setPosition(1, ETH, true, 999);
    const ethPositionButBtcFill = { ...btcLongFill(999n), coin: "BTC" };
    await expect(
      consumer.attestFillForPosition(1, makeProof(pinned, { jq: jqForOid(999n), fill: ethPositionButBtcFill }))
    ).to.be.revertedWith("FDC: fill coin != position market");
  });

  it("rejects a real fill of the wrong direction", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    const shortFill = { ...btcLongFill(), side: "Open Short" };
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: shortFill }))
    ).to.be.revertedWith("FDC: fill direction != position side");
  });

  it("refuses an unverified proof outright", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    await consumer.setProofValid(false);
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill() }))
    ).to.be.revertedWith("FDC: proof not verified");
  });

  // ------------------------------------------------------------ request pinning

  it("pins every request parameter, not just the URL", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    const cases: Array<[Record<string, string>, string]> = [
      [{ url: "https://evil.example/info" }, "FDC: wrong source URL"],
      [{ body: '{"type":"userFills","user":"0x0000000000000000000000000000000000000001"}' }, "FDC: wrong account"],
      [{ httpMethod: "GET" }, "FDC: wrong method"],
      [{ headers: "{}" }, "FDC: wrong headers"],
      [{ queryParams: '{"x":"1"}' }, "FDC: wrong query"],
      [{ abiSignature: '{"components":[],"name":"fill","type":"tuple"}' }, "FDC: wrong abi signature"],
    ];
    for (const [overrides, reason] of cases) {
      await expect(
        consumer.attestFillForPosition(
          0,
          makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill(), overrides })
        ),
        `override ${JSON.stringify(overrides)}`
      ).to.be.revertedWith(reason);
    }
  });

  // --------------------------------------------------------------- replay guards

  it("lets a fill back at most one position, and a position be bound once", async () => {
    const { vault, consumer, pinned } = await loadFixture(fixture);
    await consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill() }));

    // same position again
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill() }))
    ).to.be.revertedWith("FDC: position already attested");

    // a different position trying to reuse the same exchange fill
    await vault.setPosition(1, BTC, true, 777);
    await expect(
      consumer.attestFillForPosition(1, makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill() }))
    ).to.be.revertedWith("FDC: fill already backs a position");
  });

  it("refuses a position that has no exchange order id", async () => {
    const { vault, consumer, pinned } = await loadFixture(fixture);
    await vault.setPosition(2, BTC, true, 0); // never filled on an exchange
    await expect(
      consumer.attestFillForPosition(2, makeProof(pinned, { jq: jqForOid(0n), fill: btcLongFill(0n) }))
    ).to.be.revertedWith("FDC: position has no exchange oid");
  });

  it("does not attest the same latest-fill order id twice", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    await consumer.attestFill(makeProof(pinned, { jq: pinned.latestJq, fill: btcLongFill() }));
    expect(await consumer.attestedCount()).to.equal(1);
    await expect(
      consumer.attestFill(makeProof(pinned, { jq: pinned.latestJq, fill: btcLongFill() }))
    ).to.be.revertedWith("FDC: fill already attested");
  });

  it("keeps the standalone and position-bound namespaces independent", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    // attesting a fill standalone must not block binding it to its position
    await consumer.attestFill(makeProof(pinned, { jq: pinned.latestJq, fill: btcLongFill() }));
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: btcLongFill() }))
    ).to.not.be.reverted;
  });

  it("rejects a looser transform on the standalone path", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    await expect(
      consumer.attestFill(makeProof(pinned, { jq: "{coin: .[0].coin}", fill: btcLongFill() }))
    ).to.be.revertedWith("FDC: wrong transform");
  });

  // ------------------------------------------------- what it deliberately does NOT prove

  it("does NOT check price, size or timestamp against the position", async () => {
    const { consumer, pinned } = await loadFixture(fixture);
    // A fill with an absurd price, a mismatched size and a timestamp from years
    // earlier still attests. This is a documented limit of the attestation, not
    // an oversight: the /verify page and README state it. If a future change
    // adds equivalence checks, this test should fail and be rewritten.
    const mismatched: Fill = {
      coin: "BTC",
      side: "Open Long",
      px: "1.0",
      sz: "99999",
      oid: 777n,
      time: 1n,
    };
    await expect(
      consumer.attestFillForPosition(0, makeProof(pinned, { jq: jqForOid(777n), fill: mismatched }))
    ).to.emit(consumer, "PositionFillAttested");
  });

  it("renders order ids as digits only, so the rebuilt transform cannot be injected", async () => {
    const { vault, consumer, pinned } = await loadFixture(fixture);
    // uint64 max: the largest value a caller could push through _toString
    const big = 18446744073709551615n;
    await vault.setPosition(3, BTC, true, big);
    await expect(
      consumer.attestFillForPosition(3, makeProof(pinned, { jq: jqForOid(big), fill: btcLongFill(big) }))
    ).to.emit(consumer, "PositionFillAttested");
    // and a transform that merely contains the right digits elsewhere fails
    await vault.setPosition(4, BTC, true, 12);
    await expect(
      consumer.attestFillForPosition(
        4,
        makeProof(pinned, { jq: jqForOid(123n), fill: btcLongFill(12n) })
      )
    ).to.be.revertedWith("FDC: transform not bound to position");
  });
});
