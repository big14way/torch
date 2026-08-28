import { useSyncExternalStore } from "react";
import type { AccountInfo, WalletAdapter, WalletManager } from "xrpl-connect";
import { WAVES } from "./config";

/** XRPL wallet session for the Make Waves page.
 *
 * Same shape as lib/watch.ts: a module-level store read through
 * useSyncExternalStore, persisted in its own localStorage key. Deliberately
 * NOT wired into useEffectiveAccount or the wagmi provider tree -- an XRPL
 * signing session and a Flare trading account are different identities, and
 * merging them would quietly change what every other page thinks "connected"
 * means.
 *
 * Note the header already has a menu item called "XRP Ledger wallet" that
 * means a read-only VIEW of a Flare Smart Account. This is the other thing: a
 * real wallet that signs. The UI must never use that label for this.
 *
 * xrpl-connect is imported dynamically so the SDK and xrpl.js stay out of the
 * main bundle. Nothing in this file may be imported eagerly from App.tsx or
 * Header.tsx or that isolation is lost.
 */

const STORAGE_KEY = "torch.waves.v1";

export type WavesWallet = {
  address: string;
  walletId: string;
  walletName: string;
} | null;

let state: WavesWallet = load();
const subs = new Set<() => void>();

function load(): WavesWallet {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WavesWallet) : null;
  } catch {
    return null; // private mode
  }
}

function persist() {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

function emit() {
  subs.forEach((fn) => fn());
}

export function useWavesWallet(): WavesWallet {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
    () => null
  );
}

let managerPromise: Promise<WalletManager> | null = null;

/** Built once, on first use. Adapters are chosen deliberately:
 *
 *  - Xaman covers mobile, and only when an API key is configured. Offering a
 *    wallet that cannot work is worse than not offering it.
 *  - Crossmark and GemWallet cover desktop browsers.
 *  - WalletConnect is left OUT on purpose. wagmi already runs a WalletConnect
 *    v2 client on every page of this app; a second core in the same document
 *    shares the wc@2:* storage namespace and the sessions can cross-
 *    contaminate. It is also the one adapter where the source tag is at real
 *    risk, because autofill happens wallet-side.
 *  - Ledger, Xyra, Otsu and the MetaMask snap are deferred rather than
 *    dropped: each is a small, self-contained addition once the main flow is
 *    proven on-ledger.
 */
export async function getManager(): Promise<WalletManager> {
  if (!managerPromise) {
    managerPromise = (async () => {
      const xc = await import("xrpl-connect");
      const adapters: WalletAdapter[] = [new xc.Adapters.Crossmark(), new xc.Adapters.GemWallet()];
      if (WAVES.xamanApiKey) {
        adapters.unshift(new xc.Adapters.Xaman({ apiKey: WAVES.xamanApiKey }));
      }
      const m = new xc.WalletManager({
        adapters,
        network: WAVES.network,
        autoConnect: false,
      });
      m.on("disconnect", () => {
        state = null;
        persist();
        emit();
      });
      m.on("accountChanged", (a: unknown) => {
        const acct = a as AccountInfo | null;
        if (acct && state) {
          state = { ...state, address: acct.address };
          persist();
          emit();
        }
      });
      return m;
    })();
  }
  return managerPromise;
}

export type WalletChoice = { id: string; name: string; icon?: string; url?: string; available: boolean };

/** Every wallet we ship, each marked with whether it is actually usable here.
 * Showing an unavailable wallet greyed out, with a link to install it, beats
 * hiding it: a Crossmark user who does not see Crossmark assumes we do not
 * support it. */
export async function listWallets(): Promise<WalletChoice[]> {
  const m = await getManager();
  const available = new Set((await m.getAvailableWallets()).map((w) => w.id));
  return m.wallets.map((w) => ({
    id: w.id,
    name: w.name,
    icon: w.icon,
    url: w.url,
    available: available.has(w.id),
  }));
}

export async function connect(walletId: string): Promise<string> {
  const m = await getManager();
  const account = await m.connect(walletId);
  const wallet = m.wallets.find((w) => w.id === walletId);
  state = { address: account.address, walletId, walletName: wallet?.name ?? walletId };
  persist();
  emit();
  return account.address;
}

export async function disconnect(): Promise<void> {
  try {
    const m = await getManager();
    await m.disconnect();
  } catch {
    /* disconnecting a wallet that already went away is not an error worth showing */
  }
  state = null;
  persist();
  emit();
}
