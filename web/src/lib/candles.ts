import type { CandlestickData, LineData, UTCTimestamp } from "lightweight-charts";

/** Chart timeframes. Keys match Hyperliquid candleSnapshot intervals exactly. */
export const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const HL_INFO = "https://api.hyperliquid.xyz/info";
const BARS = 300;

/** If the FTSO testnet feed sits more than this factor away from the mainnet
 * price, real history would lie next to the live candle — use synthetic
 * warm-up instead (SOL and HYPE feeds carry test levels on Coston2). */
const MAX_DIVERGENCE = 0.2;

type HlCandle = { t: number; o: string; h: string; l: string; c: string };

/** Real mainnet history from Hyperliquid's public info endpoint (CORS-open,
 * no auth). Returns [] on any failure — callers fall back to synthetic. */
export async function fetchHlCandles(coin: string, tf: Timeframe): Promise<CandlestickData[]> {
  try {
    const endTime = Date.now();
    const startTime = endTime - BARS * TF_SECONDS[tf] * 1000;
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf, startTime, endTime } }),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as HlCandle[];
    if (!Array.isArray(rows)) return [];
    return rows.map((r) => ({
      time: Math.floor(r.t / 1000) as UTCTimestamp,
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
    }));
  } catch {
    return [];
  }
}

/** True when real history can sit next to the live FTSO mark without lying. */
export function historyUsable(hl: CandlestickData[], ftsoPrice: number): boolean {
  if (hl.length === 0 || ftsoPrice <= 0) return false;
  const last = hl[hl.length - 1].close;
  if (last <= 0) return false;
  const ratio = ftsoPrice / last;
  return ratio > 1 - MAX_DIVERGENCE && ratio < 1 + MAX_DIVERGENCE;
}

/** Synthetic warm-up history (random walk ending at the live mark) for markets
 * whose testnet feed level diverges from mainnet. Clearly labelled in the UI. */
export function synthCandles(endPrice: number, tfSec: number, n = 120): CandlestickData[] {
  const out: CandlestickData[] = [];
  const now = Math.floor(Date.now() / 1000);
  const start = (Math.floor(now / tfSec) - n) * tfSec;
  let px = endPrice * (1 + (Math.random() - 0.5) * 0.02);
  for (let i = 0; i < n; i++) {
    const drift = (endPrice - px) * 0.05;
    const open = px;
    const close = i === n - 1 ? endPrice : px + drift + px * (Math.random() - 0.5) * 0.004;
    const high = Math.max(open, close) * (1 + Math.random() * 0.0015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.0015);
    out.push({ time: (start + i * tfSec) as UTCTimestamp, open, high, low, close });
    px = close;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Indicators. All take the candle array and return line points aligned to it.
// ---------------------------------------------------------------------------

export function sma(candles: CandlestickData[], period: number): LineData[] {
  const out: LineData[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= period) sum -= candles[i - period].close;
    if (i >= period - 1) out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

export function ema(candles: CandlestickData[], period: number): LineData[] {
  const out: LineData[] = [];
  const k = 2 / (period + 1);
  let prev: number | undefined;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i].close;
    prev = prev === undefined ? c : c * k + prev * (1 - k);
    if (i >= period - 1) out.push({ time: candles[i].time, value: prev });
  }
  return out;
}

export function bollinger(
  candles: CandlestickData[],
  period = 20,
  mult = 2
): { upper: LineData[]; mid: LineData[]; lower: LineData[] } {
  const upper: LineData[] = [];
  const mid: LineData[] = [];
  const lower: LineData[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close;
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (candles[j].close - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    const t = candles[i].time;
    upper.push({ time: t, value: mean + mult * sd });
    mid.push({ time: t, value: mean });
    lower.push({ time: t, value: mean - mult * sd });
  }
  return { upper, mid, lower };
}

export function rsi(candles: CandlestickData[], period = 14): LineData[] {
  const out: LineData[] = [];
  if (candles.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const point = (i: number) => ({
    time: candles[i].time,
    value: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss),
  });
  out.push(point(period));
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out.push(point(i));
  }
  return out;
}
