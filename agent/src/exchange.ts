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
  oid: bigint; // exchange order id (0 in mock)
  venue?: string; // where it actually filled, for honest logging
}

export interface Exchange {
  name: string;
  /** Open a market position of sizeUsd6 notional. */
  open(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill>;
  /** Close the mirrored position. */
  close(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill>;
}

// ---------------------------------------------------------------------------

export class MockExchange implements Exchange {
  name = "mock";
  private nextOid = 1n;
  constructor(private markPrice6: (market: string) => Promise<bigint>) {}

  async open(market: string): Promise<Fill> {
    const price6 = await this.markPrice6(market);
    return { price6, oid: this.nextOid++ };
  }

  async close(market: string): Promise<Fill> {
    const price6 = await this.markPrice6(market);
    return { price6, oid: this.nextOid++ };
  }
}

// ---------------------------------------------------------------------------

const HL_COIN: Record<string, string> = { BTC: "BTC", ETH: "ETH", XRP: "XRP" };

export class HyperliquidTestnet implements Exchange {
  name = "hyperliquid-testnet";
  private sdkClient: any | null = null;

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
    const hl = await import("@nktkas/hyperliquid").catch(() => null);
    if (!hl) {
      throw new Error(
        "@nktkas/hyperliquid is not installed. Run: npm install @nktkas/hyperliquid -w agent"
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

  async open(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill> {
    const meta = await this.assetMeta(HL_COIN[market]);
    if (!meta) return this.fallbackFill(market); // e.g. XRP: not listed on HL testnet
    this.requireMinNotional(sizeUsd6);
    const client = await this.client();
    const mid6 = await this.mid6(market);
    // lot size = notionalUsd / price, rounded to the asset's szDecimals
    const sz = (Number(sizeUsd6) / Number(mid6)).toFixed(meta.szDecimals);
    const result = await client.order({
      orders: [
        {
          a: meta.index,
          b: isLong,
          p: this.slippagePx(mid6, isLong),
          s: sz,
          r: false,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
      ...(this.builderField() ? { builder: this.builderField() } : {}),
    });
    return this.readFill(result, "open");
  }

  async close(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill> {
    const meta = await this.assetMeta(HL_COIN[market]);
    if (!meta) return this.fallbackFill(market);
    this.requireMinNotional(sizeUsd6);
    const client = await this.client();
    const mid6 = await this.mid6(market);
    const sz = (Number(sizeUsd6) / Number(mid6)).toFixed(meta.szDecimals);
    const result = await client.order({
      orders: [
        {
          a: meta.index,
          b: !isLong, // closing = opposite side
          p: this.slippagePx(mid6, !isLong),
          s: sz,
          r: true, // reduce-only
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
      ...(this.builderField() ? { builder: this.builderField() } : {}),
    });
    return this.readFill(result, "close");
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

  private readFill(result: any, kind: string): Fill {
    const status = result?.response?.data?.statuses?.[0];
    const filled = status?.filled;
    if (!filled) throw new Error(`HL ${kind} not filled: ${JSON.stringify(status)}`);
    return {
      price6: BigInt(Math.round(parseFloat(filled.avgPx) * 1e6)),
      oid: BigInt(filled.oid ?? 0),
      venue: "hyperliquid-testnet",
    };
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

  /** Aggressive price with 1% slippage room, formatted as HL expects. */
  private slippagePx(mid6: bigint, buying: boolean): string {
    const mid = Number(mid6) / 1e6;
    const px = buying ? mid * 1.01 : mid * 0.99;
    return px.toPrecision(5);
  }
}
