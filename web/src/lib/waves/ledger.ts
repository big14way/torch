import type { Client } from "xrpl";
import { WAVES } from "./config";

/** Reads from the XRP Ledger: the count that matters, and the check that our
 * own payments actually carry the tag.
 *
 * xrpl.js is imported dynamically, like the wallet SDK, so neither lands in
 * the main bundle.
 */

let clientPromise: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { Client } = await import("xrpl");
      let lastErr: unknown;
      for (const url of WAVES.endpoints) {
        try {
          const c = new Client(url, { connectionTimeout: 15_000 });
          await c.connect();
          return c;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error("Could not reach the XRP Ledger.");
    })();
    // A failed connect must not poison every later attempt.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

export type TagCheck = {
  validated: boolean;
  succeeded: boolean;
  sourceTag: number | null;
  result: string | null;
};

/** Re-read a payment we just submitted and confirm the tag survived signing.
 *
 * This is the whole reason the check exists: the tag is added before signing,
 * but what a wallet actually signs is up to the wallet. If one silently drops
 * or overwrites it, the payment still succeeds, the user still paid, and the
 * hackathon count still does not move -- a failure that is invisible from the
 * happy path. Better to catch it on the first payment than on the last day.
 */
export async function checkTag(hash: string): Promise<TagCheck> {
  const c = await getClient();
  const res: any = await c.request({ command: "tx", transaction: hash } as any);
  const r = res?.result ?? {};
  const tx = r.tx_json ?? r;
  const meta = r.meta ?? r.metaData;
  const code = typeof meta === "object" && meta ? (meta.TransactionResult as string) : null;
  return {
    validated: r.validated === true,
    succeeded: code === "tesSUCCESS",
    sourceTag: typeof tx?.SourceTag === "number" ? tx.SourceTag : null,
    result: code,
  };
}

/** True when the address exists on-ledger. An account that has never been
 * funded cannot send anything, and telling someone that before they try beats
 * letting their wallet fail at the signing step. */
export async function isActivated(address: string): Promise<boolean> {
  const c = await getClient();
  try {
    await c.request({ command: "account_info", account: address, ledger_index: "validated" } as any);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/actNotFound|Account not found/i.test(msg)) return false;
    throw e;
  }
}

export type Wall = { addresses: string[]; distinct: number; scanned: number; truncated: boolean };

/** Everyone who has joined: distinct senders of a successful, correctly tagged
 * payment to the treasury.
 *
 * Counted from the ledger rather than from a database, so the number on the
 * page is the same number anyone else can derive. Failed transactions are
 * excluded even though they carry the tag, because a payment that did not
 * happen should not appear on a wall of people who did something.
 */
export async function readWall(maxPages = 6): Promise<Wall> {
  const c = await getClient();
  const seen = new Set<string>();
  const order: string[] = [];
  let marker: unknown = undefined;
  let scanned = 0;
  let pages = 0;

  while (pages < maxPages) {
    const res: any = await c.request({
      command: "account_tx",
      account: WAVES.treasury,
      ledger_index_min: -1,
      ledger_index_max: -1,
      limit: 200,
      forward: true,
      ...(marker ? { marker } : {}),
    } as any);
    const rows: any[] = res?.result?.transactions ?? [];
    for (const row of rows) {
      scanned++;
      const tx = row.tx_json ?? row.tx ?? {};
      const meta = row.meta ?? row.metaData;
      const ok = typeof meta === "object" && meta && meta.TransactionResult === "tesSUCCESS";
      if (!ok) continue;
      if (tx.TransactionType !== "Payment") continue;
      if (tx.SourceTag !== WAVES.sourceTag) continue;
      if (tx.Destination !== WAVES.treasury) continue;
      const from = tx.Account as string | undefined;
      if (!from || seen.has(from)) continue;
      seen.add(from);
      order.push(from);
    }
    marker = res?.result?.marker;
    pages++;
    if (!marker) break;
  }

  return { addresses: order, distinct: seen.size, scanned, truncated: Boolean(marker) };
}
