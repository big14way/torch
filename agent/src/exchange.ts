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
    private privateKey: string
  ) {}

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
    const client = await this.client();
    const mid6 = await this.mid6(market);
    const coin = HL_COIN[market];
    // size in asset units = notionalUsd / price
    const sz = Number(sizeUsd6) / Number(mid6);
    // Market order via aggressive IOC limit (Hyperliquid convention). The SDK
    // handles asset indices and signing. VERIFY: tick/lot rounding per asset.
    const result = await client.order({
      orders: [
        {
          a: await this.assetIndex(coin),
          b: isLong,
          p: this.slippagePx(mid6, isLong),
          s: sz.toFixed(4),
          r: false,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
    const status = result?.response?.data?.statuses?.[0];
    const filled = status?.filled;
    if (!filled) throw new Error(`HL open not filled: ${JSON.stringify(status)}`);
    return {
      price6: BigInt(Math.round(parseFloat(filled.avgPx) * 1e6)),
      oid: BigInt(filled.oid ?? 0),
    };
  }

  async close(market: string, isLong: boolean, sizeUsd6: bigint): Promise<Fill> {
    // Closing = opposite side, reduce-only.
    const client = await this.client();
    const mid6 = await this.mid6(market);
    const coin = HL_COIN[market];
    const sz = Number(sizeUsd6) / Number(mid6);
    const result = await client.order({
      orders: [
        {
          a: await this.assetIndex(coin),
          b: !isLong,
          p: this.slippagePx(mid6, !isLong),
          s: sz.toFixed(4),
          r: true,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
    const status = result?.response?.data?.statuses?.[0];
    const filled = status?.filled;
    if (!filled) throw new Error(`HL close not filled: ${JSON.stringify(status)}`);
    return {
      price6: BigInt(Math.round(parseFloat(filled.avgPx) * 1e6)),
      oid: BigInt(filled.oid ?? 0),
    };
  }

  private assetCache: Record<string, number> = {};
  private async assetIndex(coin: string): Promise<number> {
    if (coin in this.assetCache) return this.assetCache[coin];
    const res = await fetch(`${this.apiUrl}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "meta" }),
    });
    const meta = (await res.json()) as { universe: { name: string }[] };
    const idx = meta.universe.findIndex((u) => u.name === coin);
    if (idx < 0) throw new Error(`Asset ${coin} not in HL universe`);
    this.assetCache[coin] = idx;
    return idx;
  }

  /** Aggressive price with 1% slippage room, formatted as HL expects. */
  private slippagePx(mid6: bigint, buying: boolean): string {
    const mid = Number(mid6) / 1e6;
    const px = buying ? mid * 1.01 : mid * 0.99;
    return px.toPrecision(5);
  }
}
