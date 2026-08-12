/**
 * Asks the Flare Compute Extension what actually filled on Hyperliquid, and
 * gets back a signature the vault's adapter will verify on-chain.
 *
 * Why ask the enclave directly rather than through an on-chain instruction:
 * the consensus relay decides *who may ask*, not *whether the answer is true*.
 * The enclave looks the fill up on the exchange itself, so it cannot be talked
 * into signing something that did not happen — which means a fast local ask is
 * exactly as trustworthy as a relayed one, and returns in about a second
 * instead of a consensus round. The relayed path stays open to anyone who
 * wants to reproduce the answer independently: that is what
 * TorchInstructionSender is for.
 */

const OP_TYPE = "TORCH";
const OP_COMMAND = "ATTEST_FILL";

/** bytes32(s), right-padded — matches the node's utils.ToHash, which is NOT a hash. */
function toHash32(s: string): string {
  return "0x" + Buffer.from(s.slice(0, 32)).toString("hex").padEnd(64, "0");
}

const hexOf = (s: string) => "0x" + Buffer.from(s).toString("hex");

export type Attestation = { entryPrice6: bigint; signature: `0x${string}` };

export class TeeAttestor {
  constructor(
    private readonly actionUrl: string,
    private readonly timeoutMs = 12_000
  ) {}

  /**
   * Returns null rather than throwing whenever the enclave declines to sign —
   * unreachable, not warm, or (importantly) `found: false`, which is the
   * enclave saying the claimed order id does not exist in our account. The
   * caller must treat null as "cannot confirm this fill yet", never as
   * "confirm it some other way".
   */
  async attest(positionId: bigint, oid: bigint): Promise<Attestation | null> {
    // The extension parses this as instruction.DataFixed. Only opType,
    // opCommand and originalMessage are read; the rest of the envelope is
    // what the relay would have filled in and is ignored here.
    const dataFixed = {
      instructionId: "0x" + "00".repeat(32),
      teeId: "0x" + "00".repeat(20),
      timestamp: 0,
      rewardEpochId: 0,
      opType: toHash32(OP_TYPE),
      opCommand: toHash32(OP_COMMAND),
      cosigners: [],
      cosignersThreshold: 0,
      originalMessage: hexOf(JSON.stringify({ positionId: Number(positionId), oid: Number(oid) })),
      additionalFixedMessage: "0x",
    };
    const action = {
      data: {
        id: "0x" + "00".repeat(32),
        type: "instruction",
        submissionTag: "submit",
        message: hexOf(JSON.stringify(dataFixed)),
      },
      additionalVariableMessages: [],
      timestamps: [],
      additionalActionData: "0x",
      signatures: [],
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.actionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action),
        signal: ctl.signal,
      });
      if (!res.ok) return null;
      const result = (await res.json()) as { status?: number; log?: string; data?: string };
      if (!result?.data) return null;

      const payload = JSON.parse(Buffer.from(result.data.slice(2), "hex").toString()) as {
        found?: boolean;
        entryPrice6?: string;
        signature?: string;
      };
      if (!payload.found || !payload.entryPrice6 || !payload.signature) return null;

      return {
        entryPrice6: BigInt(payload.entryPrice6),
        signature: payload.signature as `0x${string}`,
      };
    } catch {
      return null; // unreachable enclave is a retry, not a crash
    } finally {
      clearTimeout(timer);
    }
  }
}
