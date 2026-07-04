import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * FDC Web2Json spike: attest wallet F's latest Hyperliquid testnet fill through
 * the Flare Data Connector and verify it on-chain in TorchFdcConsumer.
 * Full round trip (~3-5 min): prepareRequest -> FdcHub -> wait round -> DA proof
 * -> attestFill.  npm run fdc:attest -w contracts
 */
const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
const VERIFIER_PREPARE = "https://fdc-verifiers-testnet.flare.network/verifier/web2/Web2Json/prepareRequest";
const DA_URL = "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw";
const VERIFIER_KEY = process.env.VERIFIER_API_KEY_TESTNET || "00000000-0000-0000-0000-000000000000";
const HL_USER = "0xfDb941fe97e13B599BC576c4142128aB97D01622"; // wallet F (frozen fills)
const PROTOCOL_ID = 200;

const utf8Hex32 = (s: string) => "0x" + Buffer.from(s, "utf8").toString("hex").padEnd(64, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const abiSignature = JSON.stringify({
  components: [
    { internalType: "string", name: "coin", type: "string" },
    { internalType: "string", name: "side", type: "string" },
    { internalType: "string", name: "px", type: "string" },
    { internalType: "string", name: "sz", type: "string" },
    { internalType: "uint256", name: "oid", type: "uint256" },
    { internalType: "uint256", name: "time", type: "uint256" },
  ],
  name: "task",
  type: "tuple",
});

const requestJson = {
  attestationType: utf8Hex32("Web2Json"),
  sourceId: utf8Hex32("PublicWeb2"),
  requestBody: {
    url: "https://api.hyperliquid-testnet.xyz/info",
    httpMethod: "POST",
    headers: JSON.stringify({ "Content-Type": "application/json" }),
    queryParams: "{}",
    body: JSON.stringify({ type: "userFills", user: HL_USER }),
    postProcessJq: "{coin: .[0].coin, side: .[0].dir, px: .[0].px, sz: .[0].sz, oid: .[0].oid, time: .[0].time}",
    abiSignature,
  },
};

const RESPONSE_ABI = [
  "tuple(bytes32 attestationType,bytes32 sourceId,uint64 votingRound,uint64 lowestUsedTimestamp,tuple(string url,string httpMethod,string headers,string queryParams,string body,string postProcessJq,string abiSignature) requestBody,tuple(bytes abiEncodedData) responseBody)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const fdcPath = path.join(__dirname, "..", "..", "web", "src", "generated", "fdc.json");
  const { fdcConsumer } = JSON.parse(fs.readFileSync(fdcPath, "utf8"));
  console.log("consumer:", fdcConsumer, "| signer:", signer.address);

  console.log("1) prepareRequest ...");
  const prepRes = await fetch(VERIFIER_PREPARE, {
    method: "POST",
    headers: { "X-API-KEY": VERIFIER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(requestJson),
  });
  if (prepRes.status !== 200) throw new Error(`verifier HTTP ${prepRes.status}: ${await prepRes.text()}`);
  const prep: any = await prepRes.json();
  if (prep.status !== "VALID") throw new Error(`verifier status ${prep.status}: ${JSON.stringify(prep)}`);
  const abiEncodedRequest: string = prep.abiEncodedRequest;
  console.log("   VALID.");

  const reg = new ethers.Contract(REGISTRY, ["function getContractAddressByName(string) view returns (address)"], signer);
  const fdcHubAddr = await reg.getContractAddressByName("FdcHub");
  const feeCfgAddr = await reg.getContractAddressByName("FdcRequestFeeConfigurations");
  const fsmAddr = await reg.getContractAddressByName("FlareSystemsManager");
  const relayAddr = await reg.getContractAddressByName("Relay");

  const fdcHub = new ethers.Contract(fdcHubAddr, ["function requestAttestation(bytes) payable"], signer);
  const feeCfg = new ethers.Contract(feeCfgAddr, ["function getRequestFee(bytes) view returns (uint256)"], signer);
  const fee = await feeCfg.getRequestFee(abiEncodedRequest);
  console.log(`2) submit to FdcHub ${fdcHubAddr}, fee ${ethers.formatEther(fee)} C2FLR`);
  const tx = await fdcHub.requestAttestation(abiEncodedRequest, { value: fee });
  const receipt = await tx.wait();

  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  const fsm = new ethers.Contract(fsmAddr, ["function firstVotingRoundStartTs() view returns (uint64)", "function votingEpochDurationSeconds() view returns (uint64)"], ethers.provider);
  const t0 = BigInt(await fsm.firstVotingRoundStartTs());
  const dur = BigInt(await fsm.votingEpochDurationSeconds());
  const roundId = Number((BigInt(block!.timestamp) - t0) / dur);
  console.log(`3) voting round ${roundId} - waiting for finalization`);

  const relay = new ethers.Contract(relayAddr, ["function isFinalized(uint256,uint256) view returns (bool)"], ethers.provider);
  const s0 = Date.now();
  while (!(await relay.isFinalized(PROTOCOL_ID, roundId))) {
    if (Date.now() - s0 > 360000) throw new Error("round not finalized after 6min");
    process.stdout.write(".");
    await sleep(15000);
  }
  console.log("\n   finalized.");

  console.log("4) fetch proof from DA layer ...");
  let da: any;
  const d0 = Date.now();
  for (;;) {
    const res = await fetch(DA_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ votingRoundId: roundId, requestBytes: abiEncodedRequest }) });
    da = await res.json();
    if (da && da.response_hex) break;
    if (Date.now() - d0 > 180000) throw new Error("no proof from DA after 3min: " + JSON.stringify(da));
    await sleep(10000);
  }
  const [responseData] = ethers.AbiCoder.defaultAbiCoder().decode(RESPONSE_ABI, da.response_hex);
  // ethers decode returns a read-only Result; deep-copy to plain mutable arrays so
  // the encoder can walk it when re-encoding for attestFill (else "read only property 0").
  const deepPlain = (v: any): any =>
    Array.isArray(v) ? v.map(deepPlain)
      : v && typeof v === "object" && typeof v[Symbol.iterator] === "function" ? Array.from(v as any, deepPlain)
      : v;
  const proof = { merkleProof: [...(da.proof ?? [])], data: deepPlain(responseData) };
  console.log("   got proof, merkle nodes:", proof.merkleProof.length);

  console.log("5) attestFill on-chain ...");
  const consumer = await ethers.getContractAt("TorchFdcConsumer", fdcConsumer);
  const tx2 = await consumer.attestFill(proof);
  await tx2.wait();

  const f = await consumer.lastFill();
  const n = await consumer.attestedCount();
  console.log("\n=== ATTESTED ON-CHAIN (FDC-verified Hyperliquid fill) ===");
  console.log(`  ${f.coin} ${f.side}  px ${f.px}  sz ${f.sz}  oid ${f.oid} time ${f.time}`);
  console.log("  attestedCount:", n.toString(), "| verify tx:", tx2.hash);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
