import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmtPx } from "../lib/hooks";

const CANDLE_SECONDS = 30;

/** Synthetic history seeded from the live mark so the chart has context on a
 * fresh localnet. Once real Hyperliquid candles are wired (testnet mode),
 * swap seedCandles for the info endpoint's candleSnapshot. */
function seedCandles(endPrice: number, n = 120): CandlestickData[] {
  const out: CandlestickData[] = [];
  const now = Math.floor(Date.now() / 1000);
  const start = now - n * CANDLE_SECONDS;
  let px = endPrice * (1 + (Math.random() - 0.5) * 0.02);
  for (let i = 0; i < n; i++) {
    const drift = (endPrice - px) * 0.05;
    const open = px;
    const close = i === n - 1 ? endPrice : px + drift + px * (Math.random() - 0.5) * 0.004;
    const high = Math.max(open, close) * (1 + Math.random() * 0.0015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.0015);
    out.push({
      time: (start + i * CANDLE_SECONDS) as UTCTimestamp,
      open,
      high,
      low,
      close,
    });
    px = close;
  }
  return out;
}

export default function Chart({ marketKey, mark }: { marketKey: string; mark: bigint | undefined }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  // Per-market candle history: seeded once, then rolled forward from live marks.
  // Without this, revisiting a market regenerated a different random history.
  const cacheRef = useRef(new Map<string, CandlestickData[]>());
  const shownRef = useRef<string>("");

  // build chart once
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9c8d7e",
        fontFamily: "'Spline Sans Mono', monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "rgba(43, 33, 26, 0.5)" },
        horzLines: { color: "rgba(43, 33, 26, 0.5)" },
      },
      rightPriceScale: { borderColor: "#2b211a" },
      timeScale: { borderColor: "#2b211a", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const series = chart.addCandlestickSeries({
      upColor: "#3add9a",
      downColor: "#ff5470",
      borderUpColor: "#3add9a",
      borderDownColor: "#ff5470",
      wickUpColor: "#3add9a",
      wickDownColor: "#ff5470",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // seed once per market (cached), roll candles on mark updates
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || mark === undefined) return;
    const price = Number(mark) / 1e6;
    const cache = cacheRef.current;

    if (shownRef.current !== marketKey) {
      let candles = cache.get(marketKey);
      if (!candles) {
        candles = seedCandles(price);
        cache.set(marketKey, candles);
      }
      series.setData([...candles]);
      shownRef.current = marketKey;
      chartRef.current?.timeScale().scrollToRealTime();
      return;
    }

    const candles = cache.get(marketKey);
    if (!candles || candles.length === 0) return;
    const last = candles[candles.length - 1];
    const now = Math.floor(Date.now() / 1000);
    const bucket = (Math.floor(now / CANDLE_SECONDS) * CANDLE_SECONDS) as UTCTimestamp;

    if (bucket > (last.time as number)) {
      const fresh: CandlestickData = { time: bucket, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price };
      series.update(fresh);
      candles.push(fresh);
    } else {
      const updated: CandlestickData = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
      };
      series.update(updated);
      candles[candles.length - 1] = updated;
    }
  }, [mark, marketKey]);

  return (
    <div>
      <div className="chart-head">
        <span className="px">{mark !== undefined ? `$${fmtPx(mark)}` : "..."}</span>
        <span className="sub">{marketKey}-PERP, live 30s candles off the FTSOv2 mark (synthetic warm-up history)</span>
      </div>
      <div ref={boxRef} className="chartbox" />
    </div>
  );
}
