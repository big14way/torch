import type { Payment } from "xrpl";
import { WAVES } from "./config";
import { getManager } from "./wallet";
import { checkTag, isActivated, type TagCheck } from "./ledger";

/** The join payment.
 *
 * One Payment, fixed amount, to a published address, carrying the source tag
 * and a memo saying what it was for. Nothing else is requested and nothing is
 * approved: the XRP Ledger has no unlimited-spend concept, so there is no
 * allowance to grant here and none to revoke afterwards.
 */

function hexMemo(s: string): string {
  return Array.from(new TextEncoder().encode(s))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export type JoinResult = {
  hash: string;
  /** Null when the ledger could not be re-read in time. The payment may still
   * be perfectly fine; we just could not confirm it ourselves yet. */
  check: TagCheck | null;
};

export class JoinError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "not-connected"
      | "not-activated"
      | "declined"
      | "insufficient"
      | "network"
      | "unknown"
  ) {
    super(message);
    this.name = "JoinError";
  }
}

/** Map whatever the wallet threw onto something a person can act on. The
 * fine-grained taxonomy stays here rather than in the UI, which shows five
 * states, not fifteen. */
function classify(e: unknown): JoinError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject|denied|declin|cancel|SIGN_REJECTED|user closed/i.test(msg)) {
    return new JoinError("You declined the payment in your wallet. Nothing was sent.", "declined");
  }
  if (/tecUNFUNDED|insufficient|tecNO_DST_INSUF|balance/i.test(msg)) {
    return new JoinError(
      `Not enough XRP. You need ${WAVES.joinXrp} XRP plus the 1 XRP your account keeps in reserve.`,
      "insufficient"
    );
  }
  if (/network|timeout|fetch|websocket|disconnect|NETWORK_MISMATCH/i.test(msg)) {
    return new JoinError("Could not reach the XRP Ledger. Check your connection and try again.", "network");
  }
  return new JoinError(msg.split("\n")[0].slice(0, 200) || "Something went wrong.", "unknown");
}

export async function join(address: string, referrer?: string): Promise<JoinResult> {
  const m = await getManager();
  if (!m.connected) throw new JoinError("Connect a wallet first.", "not-connected");

  // Checked before we ask for a signature: an account that was never funded
  // cannot send, and finding that out from a wallet error is a bad first
  // experience of a project whose whole pitch is that you can check things.
  let activated: boolean;
  try {
    activated = await isActivated(address);
  } catch {
    activated = true; // a read failure must not block a real user
  }
  if (!activated) {
    throw new JoinError(
      "This address has never been funded, so the ledger will not let it send yet. It needs at least 1 XRP to activate.",
      "not-activated"
    );
  }

  const memo = referrer ? `${WAVES.memo}|from:${referrer}` : WAVES.memo;
  const tx: Payment = {
    TransactionType: "Payment",
    Account: address,
    Destination: WAVES.treasury,
    Amount: WAVES.joinDrops,
    // The whole point. Set before signing; verified after, because whether it
    // survives is the wallet's decision, not ours.
    SourceTag: WAVES.sourceTag,
    Memos: [{ Memo: { MemoData: hexMemo(memo) } }],
  };

  let hash: string;
  try {
    const res = await m.signAndSubmit(tx);
    hash = res.hash;
  } catch (e) {
    throw classify(e);
  }

  // A hash means the wallet accepted it, not that the ledger validated it.
  let check: TagCheck | null = null;
  for (let i = 0; i < 8; i++) {
    try {
      const c = await checkTag(hash);
      if (c.validated) {
        check = c;
        break;
      }
    } catch {
      /* not indexed yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  return { hash, check };
}
