/** Make Waves: Torch's XRP Ledger module.
 *
 * This is the only part of Torch that touches the real XRP Ledger. The trading
 * product runs on a test network with practice funds; a join here is one small
 * mainnet payment. Keeping that boundary obvious is a house rule, not a detail.
 */

export const WAVES = {
  /** Assigned to Torch by XRPL Commons when the team was accepted (2026-07-08).
   * Every transaction this module builds carries it, which is how the
   * organisers attribute activity to us. Disclosed on the page: a tracking
   * number the user cannot see is the kind of thing /verify exists to prevent. */
  sourceTag: 2607080001,

  /** Torch's XRPL mainnet treasury. Published here, on /verify and in the repo
   * so anyone can watch it before and after they send anything.
   *
   * Operational note for whoever runs this: set NO account flags on it. Setting
   * RequireDest would reject every payment this page builds, because they carry
   * a source tag and no destination tag -- a live `simulate` of exactly that
   * payment returns tecDST_TAG_NEEDED, which still lands and burns the sender's
   * fee. The account also has to hold the 1 XRP base reserve, or inbound
   * payments fail with tecNO_DST_INSUF_XRP. */
  treasury: "rndMFu63EEABDGXufSu3XAFdYWYPYhtdh7",

  /** 0.1 XRP, in drops. Fixed: sending more buys nothing, and any page telling
   * you otherwise is not us. */
  joinDrops: "100000",

  /** Shown to the user so nobody has to convert drops in their head. */
  joinXrp: "0.1",

  network: "mainnet" as const,

  /** Mainnet WebSocket, used to read the wall and to re-read a payment after
   * submission. xrplcluster/xrpl.ws/xrpl.link resolve to the same machine, so
   * the fallback is a Ripple-operated node rather than an alias of the first. */
  endpoints: ["wss://xrplcluster.com", "wss://s2.ripple.com"],

  /** Memo written on every join, so the payment says what it was for on-chain
   * rather than only in our database. */
  memo: "torch:waves:v1",

  /** What the hackathon actually counts: distinct XRPL mainnet accounts that
   * signed a transaction carrying the tag. Not payments, not volume, not
   * visitors. The page shows this number and no other. */
  target: 300,

  /** Final assessment, XRPL Commons. */
  deadline: "2026-09-21T13:00:00Z",

  /** Xaman needs a key from apps.xumm.dev. Empty means the Xaman option is not
   * offered at all, rather than offered and broken. */
  xamanApiKey: "",
} as const;

/** Flare Smart Accounts: the same MasterAccountController address is deployed
 * on Flare mainnet and Coston2, and `getPersonalAccount` is a pure view call
 * that resolves for ANY r-address, funded or not, with no signature and no
 * transaction. Both chains return the same address for the same input, so this
 * costs the visitor nothing and works before they connect anything. */
export const FSA = {
  controller: "0x434936d47503353f06750Db1A444DBDC5F0AD37c",
  rpc: "https://flare-api.flare.network/ext/C/rpc",
} as const;

/** Matches a classic XRPL address. Deliberately not an X-address: this module
 * builds a payment FROM the user, and the wallets return classic addresses. */
export function isXrplAddress(s: string): boolean {
  return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(s.trim());
}

export function shortAddr(a: string, n = 6): string {
  return a.length <= n * 2 + 3 ? a : `${a.slice(0, n)}...${a.slice(-4)}`;
}
