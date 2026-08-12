/**
 * Exchange adapters.
 *
 * MockExchange     fully working, fills at the FTSO mark. Lets you run the
 *                  entire loop on localhost with zero external dependencies.
 *
 * HyperliquidTestnet
 *                  scaffolded against the public Hyperliquid testnet API
 *                  (https://api.hyperliquid-testnet.xyz). Reads use the open
 *                  /info endpoint. Order placement uses the @nktkas/hyperliquid
 *                  SDK if installed (optional dependency), signed by an API
 *                  wallet that has NO withdrawal permission on Hyperliquid.
 *
 *                  VERIFY BEFORE DEMO DAY: smoke-test this module against the
 *                  live testnet. Order signing on Hyperliquid uses EIP-712
 *                  with chainId 1337 quirks that only a live round trip
 *                  proves out. The mock path is the safety net.
 */

export interface Fill {
  price6: bigint; // asset USD price, 6 decimals
  oid: bigint; // exchange order id (mock mode issues internal sequence numbers, not exchange ids)
  venue?: string; // where it actually filled, for honest logging
  /** Size that actually filled, in the asset's own units. Undefined when the
   * venue does not report it (mock, FTSO fallback). Previously dropped on the
   * floor, which meant a partial fill was recorded on-chain at full size and
   * the difference became unhedged exposure against the insurance fund. */
  szFilled?: number;
  /** Size we asked for, so callers can judge how short a partial came up. */
  szRequested?: number;
  /** True when this came from reconciling against the exchange rather than
   * from an order we just placed. A free-text venue string is not a contract;
   * callers that care whether real money just moved need a flag. */
  recovered?: boolean;
}

export interface Exchange {
  name: string;
  /** Open a market position of sizeUsd6 notional. `cloid` is a caller-supplied
   * client order id: pass a value derived from the vault position and the
   * adapter will refuse to place a second order for the same position after a
   * restart. */
  open(market: string, isLong: boolean, sizeUsd6: bigint, cloid?: string): Promise<Fill>;
  /** Close the mirrored position. */
  close(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill>;
}

// ---------------------------------------------------------------------------

export class MockExchange implements Exchange {
  name = "mock";
  private nextOid = 1n;
  constructor(private markPrice6: (market: string) => Promise<bigint>) {}

  async open(market: string, _isLong?: boolean, _sizeUsd6?: bigint, _cloid?: string): Promise<Fill> {
    const price6 = await this.markPrice6(market);
    return { price6, oid: this.nextOid++ };
  }

  async close(market: string): Promise<Fill> {
    const price6 = await this.markPrice6(market);
    return { price6, oid: this.nextOid++ };
  }
}

// ---------------------------------------------------------------------------

const HL_COIN: Record<string, string> = {
  BTC: "BTC",
  ETH: "ETH",
  XRP: "XRP",
  HYPE: "HYPE",
  SOL: "SOL",
  DOGE: "DOGE",
};

/** The Hyperliquid MASTER account that owns Torch's fills. The signing key is
 *  an API wallet, which owns none — see findFillByCloid. Pinned to the same
 *  address as attest.ts and the FCE extension so all three agree on whose book
 *  is being read; overridable only for testing against another account. */
export const HL_MASTER_ACCOUNT =
  process.env.HL_ACCOUNT || "0xfDb941fe97e13B599BC576c4142128aB97D01622";

export class HyperliquidTestnet implements Exchange {
  name = "hyperliquid-testnet";
  private sdkClient: any | null = null;
  private readonly account = HL_MASTER_ACCOUNT;

  constructor(
    private apiUrl: string,
    private privateKey: string,
    // Fallback mark for symbols HL testnet does not list (e.g. XRP): fill at
    // the on-chain FTSO mark instead of erroring, so those markets stay usable.
    private markFallback?: (market: string) => Promise<bigint>,
    // Hyperliquid builder code: tags every routed order so the venue pays the
    // builder (Torch's treasury) a fee per fill, on-chain, automatically.
    // f is in TENTHS of a basis point (f=50 -> 5 bps; perp cap is f=100 = 10 bps).
    // The paying account must approve it once via approveBuilderFee.
    private builder?: { address: `0x${string}`; feeTenthBps: number }
  ) {}

  /** Assert at boot that we are reading the book we are trading on.
   *
   * The whole duplicate-order incident reduces to querying an account with no
   * fills. That is one HTTP call to detect: the API wallet reports
   * accountValue 0, the master reports the real balance. Cheap, decisive, and
   * it fails loudly instead of silently placing a second order a week later. */
  async assertAccountReadable(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: this.account }),
    });
    if (!res.ok) throw new Error(`clearinghouseState failed: HTTP ${res.status}`);
    const st = (await res.json()) as any;
    const value = parseFloat(st?.marginSummary?.accountValue ?? "0");
    if (!(value > 0)) {
      throw new Error(
        `HL account ${this.account} reports accountValue ${value}. This is the address whose ` +
          `fills reconcile open orders; if it is the API wallet rather than the master, cloid ` +
          `recovery silently fails and every retry places a duplicate order. Set HL_ACCOUNT.`
      );
    }
    console.log(`[exchange] reconciling against HL account ${this.account} (accountValue ${value})`);
  }

  /** The builder field for an order payload, when configured. */
  private builderField(): { b: `0x${string}`; f: number } | undefined {
    if (!this.builder) return undefined;
    return { b: this.builder.address, f: this.builder.feeTenthBps };
  }

  private async client(): Promise<any> {
    if (this.sdkClient) return this.sdkClient;
    // Optional dependency: keeps `npm install` green even if the SDK is
    // unavailable. Fails loudly at first use in testnet mode.
    // Verified against @nktkas/hyperliquid 0.15.4: exports WalletClient and
    // HttpTransport({ url: { api } }); wallet accepts any signTypedData
    // signer, which a viem local account satisfies.
    let importErr: Error | null = null;
    const hl = await import("@nktkas/hyperliquid").catch((e: Error) => {
      importErr = e;
      return null;
    });
    if (!hl) {
      // Surface the REAL failure — "not installed" masked a packaging error
      // for hours during the Jul 22 enclave spike.
      throw new Error(
        `@nktkas/hyperliquid failed to import: ${(importErr as Error | null)?.message ?? "unknown"}`
      );
    }
    if (!this.privateKey) {
      throw new Error("HL_PRIVATE_KEY is empty. Set it in agent/.env for testnet mode.");
    }
    const { privateKeyToAccount } = await import("viem/accounts");
    const transport = new hl.HttpTransport({ url: { api: this.apiUrl } });
    this.sdkClient = new hl.WalletClient({
      transport,
      wallet: privateKeyToAccount(this.privateKey as `0x${string}`),
      isTestnet: true,
    });
    return this.sdkClient;
  }

  /** Mid price from the public info endpoint, normalized to 6dp. */
  async mid6(market: string): Promise<bigint> {
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    if (!res.ok) throw new Error(`HL info ${res.status}`);
    const mids = (await res.json()) as Record<string, string>;
    const coin = HL_COIN[market];
    const px = mids[coin];
    if (!px) throw new Error(`No HL mid for ${coin}`);
    return BigInt(Math.round(parseFloat(px) * 1e6));
  }

  async open(market: string, isLong: boolean, sizeUsd6: bigint, cloid?: string): Promise<Fill> {
    const meta = await this.assetMeta(HL_COIN[market]);
    if (!meta) return this.fallbackFill(market); // e.g. XRP: not listed on HL testnet

    // A crash between placing this order and the on-chain confirm used to mean
    // a SECOND real order on restart, because the in-flight set lived only in
    // memory. Ask the exchange whether this position already has a fill before
    // placing anything.
    if (cloid) {
      // Fail CLOSED. If this lookup throws we do not know whether this position
      // already has a fill, and placing another order is precisely the bug this
      // guard exists to prevent. Let it propagate: the caller treats it as a
      // failed attempt and retries later, which is recoverable. A duplicate
      // naked position is not.
      const prior = await this.findFillByCloid(cloid);
      if (prior) {
        // Recovered fills used to return straight out of here, skipping the
        // partial-fill check and carrying no szRequested — so a half-filled
        // recovery was reported on-chain at full notional and the remainder
        // became unhedged exposure. Size it the same way a fresh order is.
        const wantSz = parseFloat(
          (Number(sizeUsd6) / Number(await this.mid6(market))).toFixed(meta.szDecimals)
        );
        return this.requireFullFill(
          { ...prior, szRequested: wantSz },
          market,
          isLong,
          "open"
        );
      }
    }
    this.requireMinNotional(sizeUsd6);
    const client = await this.client();
    const mid6 = await this.mid6(market);
    // lot size = notionalUsd / price, rounded to the asset's szDecimals
    const sz = (Number(sizeUsd6) / Number(mid6)).toFixed(meta.szDecimals);
    const szNum = parseFloat(sz);
    const result = await client.order({
      orders: [
        {
          a: meta.index,
          b: isLong,
          p: this.slippagePx(mid6, isLong),
          s: sz,
          r: false,
          t: { limit: { tif: "Ioc" } },
          ...(cloid ? { c: cloid } : {}),
        },
      ],
      grouping: "na",
      ...(this.builderField() ? { builder: this.builderField() } : {}),
    });
    return this.requireFullFill(this.readFill(result, "open", szNum), market, isLong, "open");
  }

  async close(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill> {
    const meta = await this.assetMeta(HL_COIN[market]);
    if (!meta) return this.fallbackFill(market);
    this.requireMinNotional(sizeUsd6);
    const client = await this.client();
    const mid6 = await this.mid6(market);
    const sz = (Number(sizeUsd6) / Number(mid6)).toFixed(meta.szDecimals);
    const szNum = parseFloat(sz);
    // Reduce-only is only valid when the venue's NET position for this asset is
    // on the side we are shrinking and at least this size. Hyperliquid nets per
    // asset, but Torch hedges per position, so a mixed book — say a $78 short
    // and a $30 long — nets short while the agent still has longs to close, and
    // "sell reduce-only" is rejected as "would increase position".
    //
    // That was masked for a week: duplicate orders left the book so long that
    // reduce-only always had room. With the book correctly hedged it surfaces
    // immediately. Netting means a plain order moves net exposure by exactly the
    // same amount, so fall back to one and say so in the log.
    const szi = await this.netSzi(market);
    const reducing = isLong ? szi >= szNum : szi <= -szNum;
    if (!reducing) {
      console.log(
        `[exchange] ${market} net szi ${szi}; a reduce-only close of ${szNum} would be rejected, ` +
          `placing a plain offsetting order instead (net exposure moves identically)`
      );
    }
    const result = await client.order({
      orders: [
        {
          a: meta.index,
          b: !isLong, // closing = opposite side
          p: this.slippagePx(mid6, !isLong),
          s: sz,
          r: reducing,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
      ...(this.builderField() ? { builder: this.builderField() } : {}),
    });
    return this.readFill(result, "close", szNum);
  }

  /** Signed net position size for an asset, in asset units. Positive is long. */
  private async netSzi(market: string): Promise<number> {
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: this.account }),
    });
    if (!res.ok) throw new Error(`clearinghouseState failed: HTTP ${res.status}`);
    const st = (await res.json()) as any;
    const coin = HL_COIN[market];
    for (const a of st?.assetPositions ?? []) {
      if (a?.position?.coin === coin) return parseFloat(a.position.szi ?? "0");
    }
    return 0;
  }

  /** Look for an existing fill carrying this client order id. Makes open()
   * idempotent across a restart: the exchange, not our memory, is the record
   * of what we already did.
   *
   * This asks about HL_ACCOUNT, the MASTER account. It used to derive the
   * address from the signing key, which is an API wallet — and on Hyperliquid
   * an API wallet owns no fills, they belong to the master. So the query always
   * hit an account with zero fills, always returned undefined, and open()
   * always placed another order. Recovery never worked once: 66 duplicate
   * orders for position 0 on Aug 6, 28 for #17, 38 for #18. The two other
   * userFills callers in this repo (attest.ts, extension.go) already pin the
   * master, which is what made the bug findable. */
  private async findFillByCloid(cloid: string): Promise<Fill | undefined> {
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "userFills", user: this.account }),
    });
    if (!res.ok) throw new Error(`userFills lookup failed: HTTP ${res.status}`);
    const fills = (await res.json()) as Array<Record<string, any>>;
    if (!Array.isArray(fills)) throw new Error("userFills returned a non-array");

    const matches = fills.filter((f) => f.cloid === cloid);
    if (matches.length === 0) {
      console.log(`[exchange] no prior fill for cloid ${cloid}; placing a new order`);
      return undefined;
    }

    // Group by OID, not by cloid. One ORDER can fill in several legs sharing an
    // oid, and those must be size-weighted or we report one leg's price for the
    // whole position. But SEPARATE orders under the same cloid — exactly what
    // the broken recovery produced, 38 of them for position #18 — each carry
    // their own oid, and summing across those would claim 38x the size actually
    // requested. Take the most recent order; aggregate only its legs.
    let newestOid = 0n;
    let newestTime = -1;
    for (const m of matches) {
      const t = Number(m.time ?? 0);
      if (t >= newestTime) {
        newestTime = t;
        newestOid = BigInt(m.oid ?? 0);
      }
    }
    let sz = 0;
    let notional = 0;
    let legs = 0;
    for (const l of matches) {
      if (BigInt(l.oid ?? 0) !== newestOid) continue;
      const lsz = parseFloat(l.sz ?? "0");
      const lpx = parseFloat(l.px ?? "0");
      if (!(lsz > 0) || !(lpx > 0)) continue;
      sz += lsz;
      notional += lsz * lpx;
      legs++;
    }
    if (!(sz > 0)) return undefined;
    if (matches.length > legs) {
      console.log(
        `[exchange] cloid ${cloid}: ${matches.length} fills across several orders; recovering only oid ${newestOid} (${legs} leg(s), sz ${sz})`
      );
    }
    return {
      price6: BigInt(Math.round((notional / sz) * 1e6)),
      oid: newestOid,
      venue: `hyperliquid-testnet (recovered by cloid${legs > 1 ? `, ${legs} legs` : ""})`,
      szFilled: sz,
      recovered: true,
    };
  }

  /** Flatten `sz` asset units of an existing position. Used to undo a partial
   * open before it can become unhedged exposure. */
  private async reduceOnly(market: string, wasLong: boolean, sz: number): Promise<void> {
    const meta = await this.assetMeta(HL_COIN[market]);
    if (!meta || sz <= 0) return;
    const client = await this.client();
    const mid6 = await this.mid6(market);
    // Same netting caveat as close(): on a mixed book the venue's net can be on
    // the other side, and reduce-only is then rejected — which would leave a
    // partial fill un-unwound, i.e. exactly the naked exposure this exists to
    // prevent. Offset plainly when reduce-only cannot apply.
    const szi = await this.netSzi(market);
    const reducing = wasLong ? szi >= sz : szi <= -sz;
    await client.order({
      orders: [
        {
          a: meta.index,
          b: !wasLong,
          p: this.slippagePx(mid6, !wasLong),
          s: sz.toFixed(meta.szDecimals),
          r: reducing,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
      ...(this.builderField() ? { builder: this.builderField() } : {}),
    });
  }

  // HL rejects orders below ~$10 notional.
  private static readonly MIN_NOTIONAL_USD6 = 10_000_000n;

  private requireMinNotional(sizeUsd6: bigint): void {
    if (sizeUsd6 < HyperliquidTestnet.MIN_NOTIONAL_USD6) {
      throw new Error(
        `HL min order is ~$10; this position is $${(Number(sizeUsd6) / 1e6).toFixed(2)}. Raise margin or leverage.`
      );
    }
  }

  private async fallbackFill(market: string): Promise<Fill> {
    if (!this.markFallback) {
      throw new Error(`${HL_COIN[market]} is not on HL testnet and no FTSO fallback was provided`);
    }
    return { price6: await this.markFallback(market), oid: 0n, venue: "ftso-mark (not on HL testnet)" };
  }

  private readFill(result: any, kind: string, szRequested?: number): Fill {
    const status = result?.response?.data?.statuses?.[0];
    const filled = status?.filled;
    if (!filled) throw new Error(`HL ${kind} not filled: ${JSON.stringify(status)}`);
    const szFilled = filled.totalSz !== undefined ? parseFloat(filled.totalSz) : undefined;
    return {
      price6: BigInt(Math.round(parseFloat(filled.avgPx) * 1e6)),
      oid: BigInt(filled.oid ?? 0),
      venue: "hyperliquid-testnet",
      szFilled,
      szRequested,
    };
  }

  /** IOC orders can come back partially filled. The vault records the position
   * at its FULL notional, so anything short of the ask is naked directional
   * risk carried by the insurance fund. Unwind the partial and fail loudly:
   * the position stays Requested and the (now capped) retry can try again with
   * a flat book, which is strictly safer than silently running unhedged. */
  private async requireFullFill(f: Fill, market: string, isLong: boolean, kind: string): Promise<Fill> {
    const want = f.szRequested;
    const got = f.szFilled;
    if (want === undefined || got === undefined || want <= 0) return f; // venue did not report size
    if (got >= want * 0.999) return f;
    if (kind === "open") {
      try {
        await this.reduceOnly(market, isLong, got);
      } catch (e) {
        throw new Error(
          `HL open filled ${got}/${want} and the unwind FAILED (${(e as Error).message}). ` +
            `Manual check needed: the book is not flat.`
        );
      }
    }
    throw new Error(`HL ${kind} partially filled ${got}/${want}; unwound, will retry`);
  }

  private metaCache: Record<string, { index: number; szDecimals: number } | null> = {};
  /** Resolve an asset's HL index + szDecimals, or null if HL does not list it. */
  private async assetMeta(coin: string): Promise<{ index: number; szDecimals: number } | null> {
    if (coin in this.metaCache) return this.metaCache[coin];
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    const meta = (await res.json()) as { universe: { name: string; szDecimals: number }[] };
    const idx = meta.universe.findIndex((u) => u.name === coin);
    const found = idx < 0 ? null : { index: idx, szDecimals: meta.universe[idx].szDecimals };
    this.metaCache[coin] = found;
    return found;
  }

  /** Aggressive price with 1% slippage room, formatted as HL expects.
   *
   * Hyperliquid wants at most 5 significant figures and at most 6 decimals.
   * toPrecision(5) satisfies the first but emits EXPONENTIAL notation once a
   * price reaches six figures -- (124690.56).toPrecision(5) is "1.2469e+5",
   * which the API rejects. That made every BTC order fail, and mock mode could
   * never surface it. Round to 5 significant figures numerically, then print
   * in plain decimal. */
  private slippagePx(mid6: bigint, buying: boolean): string {
    const mid = Number(mid6) / 1e6;
    const px = buying ? mid * 1.01 : mid * 0.99;
    if (!Number.isFinite(px) || px <= 0) return "0";
    const magnitude = Math.floor(Math.log10(px)) + 1;
    const decimals = Math.min(6, Math.max(0, 5 - magnitude));
    return px.toFixed(decimals);
  }
}
