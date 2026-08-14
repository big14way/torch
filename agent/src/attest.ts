/**
 * Per-fill FDC auto-attestation. After a venue-routed fill is confirmed
 * on-chain, the enclave re-proves it through the Flare Data Connector and
 * binds it to the vault position in TorchFdcConsumer — the receipt path that
 * used to be an operator-run script now runs for every real fill.
 *
 * Deliberately OFF the fill hot path: a queue with a single worker, so a
 * ~3-5 min FDC round trip (or an outage at the verifier/DA layer) never
 * stalls fills, closes, or liquidations. Attestation is a receipt, not a
 * gate: failures are counted and retried, never escalated to the loop.
 */
import type { PublicClient, WalletClient, Account } from "viem";
import { decodeAbiParameters } from "viem";

const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019" as const;
const VERIFIER_PREPARE =
  "https://fdc-verifiers-testnet.flare.network/verifier/web2/Web2Json/prepareRequest";
const DA_URL =
  "https://ctn2-data-availability.flare.network/api/v1/fdc/proof-by-request-round-raw";
const PROTOCOL_ID = 200n;
const HL_USER = "0xfDb941fe97e13B599BC576c4142128aB97D01622"; // pinned in the consumer

const utf8Hex32 = (s: string) =>
  ("0x" + Buffer.from(s, "utf8").toString("hex").padEnd(64, "0")) as `0x${string}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ABI_SIGNATURE = JSON.stringify({
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

// Same select-by-oid transform TorchFdcConsumer reconstructs on-chain; any
// deviation makes the proof unverifiable, which is the point.
const oidJq = (oid: bigint) =>
  `map(select(.oid == ${oid})) | .[0] | {coin: .coin, side: .dir, px: .px, sz: .sz, oid: .oid, time: .time}`;

const REGISTRY_ABI = [
  {
    type: "function",
    name: "getContractAddressByName",
    stateMutability: "view",
    inputs: [{ type: "string" }],
    outputs: [{ type: "address" }],
  },
] as const;

const RESPONSE_COMPONENTS = {
  type: "tuple",
  components: [
    { name: "attestationType", type: "bytes32" },
    { name: "sourceId", type: "bytes32" },
    { name: "votingRound", type: "uint64" },
    { name: "lowestUsedTimestamp", type: "uint64" },
    {
      name: "requestBody",
      type: "tuple",
      components: [
        { name: "url", type: "string" },
        { name: "httpMethod", type: "string" },
        { name: "headers", type: "string" },
        { name: "queryParams", type: "string" },
        { name: "body", type: "string" },
        { name: "postProcessJq", type: "string" },
        { name: "abiSignature", type: "string" },
      ],
    },
    {
      name: "responseBody",
      type: "tuple",
      components: [{ name: "abiEncodedData", type: "bytes" }],
    },
  ],
} as const;

const CONSUMER_ABI = [
  {
    type: "function",
    name: "attestFillForPosition",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      {
        name: "proof",
        type: "tuple",
        // The struct's second field is named `data` (IWeb2Json.Proof) and
        // viem's tuple encoder looks values up BY NAME — an unnamed component
        // here made every encode throw after the FDC fee was already paid.
        components: [
          { name: "merkleProof", type: "bytes32[]" },
          { ...RESPONSE_COMPONENTS, name: "data" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "positionAttestedOid",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint64" }],
  },
] as const;

export interface AttestStats {
  queued: number;
  /** Attestations this process landed. Resets on restart — see `bound`. */
  landed: number;
  /** Positions confirmed bound on-chain, whether this process did it or an
   * earlier one did. This is the number that answers "is the FDC path
   * working", because `landed` resets every restart and the enclave restarts
   * on every deploy. The site links this endpoint as proof, and it was
   * reporting 2 while the chain held 14. */
  bound: number;
  failed: number;
  lastTx: string | null;
  lastError: string | null;
}

interface Job {
  positionId: bigint;
  oid: bigint;
  attempts: number;
}

export function startAttester(opts: {
  pub: PublicClient;
  wallet: WalletClient;
  account: Account;
  consumer: `0x${string}`;
  verifierKey: string;
  log: (id: bigint, msg: string) => void;
}) {
  const { pub, wallet, account, consumer, verifierKey, log } = opts;
  const stats: AttestStats = { queued: 0, landed: 0, bound: 0, failed: 0, lastTx: null, lastError: null };
  const queue: Job[] = [];
  let running = false;

  const registryRead = (name: string) =>
    pub.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "getContractAddressByName",
      args: [name],
    }) as Promise<`0x${string}`>;

  // Distinct positions confirmed bound, so re-scans do not inflate the count.
  // The first version of this counter incremented on every sighting and the
  // status endpoint climbed to 944 against ~20 real attestations — overstating
  // proof is worse than the understating bug it replaced.
  const countedBound = new Set<string>();
  const countBound = (positionId: bigint) => {
    const k = positionId.toString();
    if (countedBound.has(k)) return false;
    countedBound.add(k);
    stats.bound = countedBound.size;
    return true;
  };

  async function attestOne(job: Job): Promise<void> {
    // Restart idempotence: skip anything already bound on-chain.
    const bound = (await pub.readContract({
      address: consumer,
      abi: CONSUMER_ABI,
      functionName: "positionAttestedOid",
      args: [job.positionId],
    })) as bigint;
    if (bound !== 0n) {
      // Already proved, by us or by a previous process. Count it once:
      // skipping the work is not the same as the work not having happened,
      // but seeing it again is not more work having happened either.
      if (countBound(job.positionId)) {
        log(job.positionId, `attest: already bound (oid ${bound}), counted`);
      }
      return;
    }

    // 1) prepare at the verifier
    const requestJson = {
      attestationType: utf8Hex32("Web2Json"),
      sourceId: utf8Hex32("PublicWeb2"),
      requestBody: {
        url: "https://api.hyperliquid-testnet.xyz/info",
        httpMethod: "POST",
        headers: JSON.stringify({ "Content-Type": "application/json" }),
        queryParams: "{}",
        body: JSON.stringify({ type: "userFills", user: HL_USER }),
        postProcessJq: oidJq(job.oid),
        abiSignature: ABI_SIGNATURE,
      },
    };
    const prepRes = await fetch(VERIFIER_PREPARE, {
      method: "POST",
      headers: { "X-API-KEY": verifierKey, "Content-Type": "application/json" },
      body: JSON.stringify(requestJson),
    });
    if (prepRes.status !== 200) throw new Error(`verifier HTTP ${prepRes.status}`);
    const prep = (await prepRes.json()) as { status: string; abiEncodedRequest: `0x${string}` };
    if (prep.status !== "VALID") throw new Error(`verifier status ${prep.status}`);

    // 2) submit to FdcHub with the configured fee
    const [fdcHub, feeCfg, fsm, relay] = await Promise.all([
      registryRead("FdcHub"),
      registryRead("FdcRequestFeeConfigurations"),
      registryRead("FlareSystemsManager"),
      registryRead("Relay"),
    ]);
    const fee = (await pub.readContract({
      address: feeCfg,
      abi: [
        {
          type: "function",
          name: "getRequestFee",
          stateMutability: "view",
          inputs: [{ type: "bytes" }],
          outputs: [{ type: "uint256" }],
        },
      ] as const,
      functionName: "getRequestFee",
      args: [prep.abiEncodedRequest],
    })) as bigint;
    const reqHash = await wallet.writeContract({
      address: fdcHub,
      abi: [
        {
          type: "function",
          name: "requestAttestation",
          stateMutability: "payable",
          inputs: [{ type: "bytes" }],
          outputs: [],
        },
      ] as const,
      functionName: "requestAttestation",
      args: [prep.abiEncodedRequest],
      value: fee,
      account,
      chain: null,
    });
    // 3) voting round from the request block's timestamp. If the receipt
    // endpoint lags (a documented Coston2 mode), fall back to the latest
    // block: rounds are 90s and the submission just happened, so the round
    // derived from "now" is the same one.
    let blockTs: bigint;
    try {
      const receipt = await pub.waitForTransactionReceipt({
        hash: reqHash,
        timeout: 120_000,
        pollingInterval: 5_000,
      });
      blockTs = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp;
    } catch {
      blockTs = (await pub.getBlock()).timestamp;
      log(job.positionId, `attest: receipt lagged, deriving round from latest block`);
    }
    const block = { timestamp: blockTs };
    const [t0, dur] = await Promise.all([
      pub.readContract({
        address: fsm,
        abi: [
          {
            type: "function",
            name: "firstVotingRoundStartTs",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "uint64" }],
          },
        ] as const,
        functionName: "firstVotingRoundStartTs",
      }) as Promise<bigint>,
      pub.readContract({
        address: fsm,
        abi: [
          {
            type: "function",
            name: "votingEpochDurationSeconds",
            stateMutability: "view",
            inputs: [],
            outputs: [{ type: "uint64" }],
          },
        ] as const,
        functionName: "votingEpochDurationSeconds",
      }) as Promise<bigint>,
    ]);
    const roundId = (block.timestamp - t0) / dur;

    // 4) wait for round finalization (up to 10 min — testnet rounds run long)
    const started = Date.now();
    for (;;) {
      // One 429/blip from the public RPC must not scrap a 15-minute pipeline:
      // tolerate poll errors until the deadline.
      try {
        const finalized = (await pub.readContract({
          address: relay,
          abi: [
            {
              type: "function",
              name: "isFinalized",
              stateMutability: "view",
              inputs: [{ type: "uint256" }, { type: "uint256" }],
              outputs: [{ type: "bool" }],
            },
          ] as const,
          functionName: "isFinalized",
          args: [PROTOCOL_ID, roundId],
        })) as boolean;
        if (finalized) break;
      } catch {
        // transient read failure — keep polling
      }
      if (Date.now() - started > 600_000) throw new Error(`round ${roundId} not finalized in 10m`);
      await sleep(15_000);
    }

    // 5) proof from the DA layer
    let da: { response_hex?: `0x${string}`; proof?: `0x${string}`[] } = {};
    const daStart = Date.now();
    for (;;) {
      try {
        const res = await fetch(DA_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ votingRoundId: Number(roundId), requestBytes: prep.abiEncodedRequest }),
        });
        if (res.ok) {
          da = (await res.json()) as typeof da;
          if (da.response_hex) break;
        }
      } catch {
        // transient DA-layer failure — keep polling
      }
      if (Date.now() - daStart > 300_000) throw new Error("no DA proof in 5m");
      await sleep(10_000);
    }

    // 6) verify + bind on-chain
    const [responseData] = decodeAbiParameters([RESPONSE_COMPONENTS], da.response_hex!);
    const attHash = await wallet.writeContract({
      address: consumer,
      abi: CONSUMER_ABI,
      functionName: "attestFillForPosition",
      args: [job.positionId, { merkleProof: da.proof ?? [], data: responseData } as never],
      account,
      chain: null,
    });
    await pub.waitForTransactionReceipt({ hash: attHash, timeout: 120_000, pollingInterval: 5_000 });
    stats.landed += 1;
    countBound(job.positionId);
    stats.lastTx = attHash;
    log(job.positionId, `ATTESTED position -> oid ${job.oid}, tx ${attHash.slice(0, 10)}`);
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue[0];
        try {
          await attestOne(job);
          queue.shift();
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          // The consumer's replay guard means "already attested" is a success.
          if (/already attested/i.test(msg)) {
            queue.shift();
            continue;
          }
          job.attempts += 1;
          if (job.attempts >= 3) {
            queue.shift();
            stats.failed += 1;
            stats.lastError = msg.slice(0, 160);
            log(job.positionId, `attest FAILED after 3 tries: ${msg.slice(0, 120)}`);
          } else {
            log(job.positionId, `attest attempt ${job.attempts} failed, retrying in 60s`);
            await sleep(60_000);
          }
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    stats,
    pending: () => queue.length,
    enqueue(positionId: bigint, oid: bigint) {
      if (oid === 0n) return; // FTSO-mark fills carry nothing to attest
      if (queue.some((j) => j.positionId === positionId)) return; // in flight
      queue.push({ positionId, oid, attempts: 0 });
      stats.queued += 1;
      void drain();
    },
  };
}
