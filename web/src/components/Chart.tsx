import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type CandlestickData,
  type LineData,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { fmtPx, useXrpPrice } from "../lib/hooks";
import type { Position } from "../lib/config";
import {
  TIMEFRAMES,
  TF_SECONDS,
  type Timeframe,
  fetchHlCandles,
  historyUsable,
  synthCandles,
  sma,
  ema,
  bollinger,
  rsi,
} from "../lib/candles";
import { TrendlinesPrimitive, type Trendline, type TrendPoint } from "./chart/trendline";

const MAINTENANCE = 0.05; // mirrors maintenanceMarginBps = 500

type Source = "hl" | "synth";
type CacheEntry = { candles: CandlestickData[]; source: Source };
type Drawings = { hlines: number[]; trends: Trendline[] };
type DrawMode = "none" | "hline" | "trend";
type Toggles = { ema: boolean; sma: boolean; bb: boolean; rsi: boolean };

const EMA_PERIOD = 20;
const SMA_PERIOD = 50;

export default function Chart({
  marketKey,
  mark,
  positions,
}: {
  marketKey: string;
  mark: bigint | undefined;
  positions?: Position[];
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const overlayRef = useRef<{
    ema: ISeriesApi<"Line">;
    sma: ISeriesApi<"Line">;
    bbU: ISeriesApi<"Line">;
    bbM: ISeriesApi<"Line">;
    bbL: ISeriesApi<"Line">;
  } | null>(null);
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const trendPrimRef = useRef<TrendlinesPrimitive | null>(null);

  // data cache per market:tf, plus per-market drawings
  const cacheRef = useRef(new Map<string, CacheEntry>());
  const drawingsRef = useRef(new Map<string, Drawings>());
  const hlineObjsRef = useRef<IPriceLine[]>([]);
  const posLineObjsRef = useRef<IPriceLine[]>([]);
  const shownRef = useRef<string>(""); // `${market}:${tf}` currently on screen
  const loadTokenRef = useRef(0);
  const pendingTrendRef = useRef<TrendPoint | null>(null);

  const [tf, setTf] = useState<Timeframe>("15m");
  const [togg, setTogg] = useState<Toggles>({ ema: true, sma: false, bb: false, rsi: false });
  const [drawMode, setDrawMode] = useState<DrawMode>("none");
  const [source, setSource] = useState<Source>("synth");
  const [legend, setLegend] = useState<string>("");

  const drawModeRef = useRef<DrawMode>("none");
  drawModeRef.current = drawMode;
  const tfRef = useRef(tf);
  tfRef.current = tf;

  const { data: xrpPx } = useXrpPrice();

  const drawingsFor = (key: string): Drawings => {
    let d = drawingsRef.current.get(key);
    if (!d) {
      d = { hlines: [], trends: [] };
      drawingsRef.current.set(key, d);
    }
    return d;
  };

  // ---- build chart + all series once -------------------------------------
  useEffect(() => {
    if (!boxRef.current) return;
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9c8d7e",
        fontFamily: "'Spline Sans Mono', monospace",
        fontSize: 11,
        panes: { separatorColor: "#2b211a", separatorHoverColor: "#3a2d23" },
      },
      grid: {
        vertLines: { color: "rgba(43, 33, 26, 0.5)" },
        horzLines: { color: "rgba(43, 33, 26, 0.5)" },
      },
      rightPriceScale: { borderColor: "#2b211a" },
      timeScale: { borderColor: "#2b211a", timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#3add9a",
      downColor: "#ff5470",
      borderUpColor: "#3add9a",
      borderDownColor: "#ff5470",
      wickUpColor: "#3add9a",
      wickDownColor: "#ff5470",
    });
    const line = (color: string, width: 1 | 2 = 1, visible = false) =>
      chart.addSeries(LineSeries, {
        color,
        lineWidth: width,
        visible,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    overlayRef.current = {
      ema: line("#ff6a2b", 2, true),
      sma: line("#7aa2ff", 2),
      bbU: line("rgba(255,194,75,0.65)"),
      bbM: line("rgba(255,194,75,0.35)"),
      bbL: line("rgba(255,194,75,0.65)"),
    };
    const trendPrim = new TrendlinesPrimitive();
    candles.attachPrimitive(trendPrim);
    trendPrimRef.current = trendPrim;
    chartRef.current = chart;
    candleRef.current = candles;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      overlayRef.current = null;
      rsiRef.current = null;
      trendPrimRef.current = null;
      hlineObjsRef.current = [];
      posLineObjsRef.current = [];
      shownRef.current = "";
    };
  }, []);

  // ---- indicator computation + painting ----------------------------------
  const paintIndicators = (candles: CandlestickData[], full: boolean) => {
    const o = overlayRef.current;
    if (!o) return;
    const paint = (s: ISeriesApi<"Line">, data: LineData[]) => {
      if (data.length === 0) return;
      if (full) s.setData(data);
      else s.update(data[data.length - 1]);
    };
    paint(o.ema, ema(candles, EMA_PERIOD));
    paint(o.sma, sma(candles, SMA_PERIOD));
    const bb = bollinger(candles);
    paint(o.bbU, bb.upper);
    paint(o.bbM, bb.mid);
    paint(o.bbL, bb.lower);
    if (rsiRef.current) paint(rsiRef.current, rsi(candles));
  };

  // ---- load history on market/tf change ----------------------------------
  useEffect(() => {
    const series = candleRef.current;
    if (!series || mark === undefined) return;
    const key = `${marketKey}:${tf}`;
    if (shownRef.current === key) return;
    const price = Number(mark) / 1e6;
    const token = ++loadTokenRef.current;

    const show = (entry: CacheEntry) => {
      if (loadTokenRef.current !== token) return; // superseded
      series.setData([...entry.candles]);
      paintIndicators(entry.candles, true);
      setSource(entry.source);
      shownRef.current = key;
      applyDrawings(marketKey);
      chartRef.current?.timeScale().scrollToRealTime();
    };

    const cached = cacheRef.current.get(key);
    if (cached) {
      show(cached);
      return;
    }
    (async () => {
      const hl = await fetchHlCandles(marketKey, tf);
      const entry: CacheEntry = historyUsable(hl, price)
        ? { candles: hl, source: "hl" }
        : { candles: synthCandles(price, TF_SECONDS[tf]), source: "synth" };
      cacheRef.current.set(key, entry);
      show(entry);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey, tf, mark === undefined]);

  // ---- roll the live candle off the FTSO mark ----------------------------
  useEffect(() => {
    const series = candleRef.current;
    const key = `${marketKey}:${tf}`;
    if (!series || mark === undefined || shownRef.current !== key) return;
    const entry = cacheRef.current.get(key);
    if (!entry || entry.candles.length === 0) return;
    const candles = entry.candles;
    const price = Number(mark) / 1e6;
    const tfSec = TF_SECONDS[tf];
    const last = candles[candles.length - 1];
    const bucket = (Math.floor(Date.now() / 1000 / tfSec) * tfSec) as UTCTimestamp;

    if (bucket > (last.time as number)) {
      const fresh: CandlestickData = {
        time: bucket,
        open: last.close,
        high: Math.max(last.close, price),
        low: Math.min(last.close, price),
        close: price,
      };
      series.update(fresh);
      candles.push(fresh);
      paintIndicators(candles, true);
    } else {
      const updated: CandlestickData = {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price,
      };
      series.update(updated);
      candles[candles.length - 1] = updated;
      paintIndicators(candles, false);
    }
  }, [mark, marketKey, tf]);

  // ---- indicator visibility ----------------------------------------------
  useEffect(() => {
    const o = overlayRef.current;
    const chart = chartRef.current;
    if (!o || !chart) return;
    o.ema.applyOptions({ visible: togg.ema });
    o.sma.applyOptions({ visible: togg.sma });
    o.bbU.applyOptions({ visible: togg.bb });
    o.bbM.applyOptions({ visible: togg.bb });
    o.bbL.applyOptions({ visible: togg.bb });
    if (togg.rsi && !rsiRef.current) {
      const s = chart.addSeries(
        LineSeries,
        { color: "#ffc24b", lineWidth: 1, priceLineVisible: false, lastValueVisible: true },
        1
      );
      s.createPriceLine({ price: 70, color: "#6b5f53", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "70" });
      s.createPriceLine({ price: 30, color: "#6b5f53", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "30" });
      rsiRef.current = s;
      const entry = cacheRef.current.get(shownRef.current);
      if (entry) s.setData(rsi(entry.candles));
      const panes = chart.panes();
      if (panes.length > 1) {
        panes[0].setStretchFactor(3);
        panes[1].setStretchFactor(1);
      }
    } else if (!togg.rsi && rsiRef.current) {
      chart.removeSeries(rsiRef.current);
      rsiRef.current = null;
    }
  }, [togg]);

  // ---- drawings ----------------------------------------------------------
  /** Trendline endpoints are stored at the bar-time they were drawn on; other
   * timeframes have different bar times, and timeToCoordinate returns null for
   * a time the scale doesn't know — so snap each endpoint to the nearest bar
   * that exists on the CURRENT timeframe before handing lines to the canvas. */
  const snapTrends = (trends: Trendline[]): Trendline[] => {
    const entry = cacheRef.current.get(`${marketKey}:${tfRef.current}`);
    if (!entry || entry.candles.length === 0) return trends;
    const tfSec = TF_SECONDS[tfRef.current];
    const first = entry.candles[0].time as number;
    const last = entry.candles[entry.candles.length - 1].time as number;
    const snap = (p: TrendPoint): TrendPoint => {
      const t = Math.min(Math.max(Math.round((p.time as number) / tfSec) * tfSec, first), last);
      return { time: t as UTCTimestamp, price: p.price };
    };
    return trends.map((t) => ({ a: snap(t.a), b: snap(t.b) }));
  };

  const applyDrawings = (mkt: string) => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of hlineObjsRef.current) series.removePriceLine(l);
    hlineObjsRef.current = [];
    const d = drawingsFor(mkt);
    for (const price of d.hlines) {
      hlineObjsRef.current.push(
        series.createPriceLine({
          price,
          color: "#ffc24b",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: "—",
        })
      );
    }
    trendPrimRef.current?.setLines(snapTrends(d.trends), null);
  };

  const clearDrawings = () => {
    const d = drawingsFor(marketKey);
    d.hlines = [];
    d.trends = [];
    pendingTrendRef.current = null;
    applyDrawings(marketKey);
    setDrawMode("none");
  };

  // click + crosshair handlers (drawing tools, OHLC legend)
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (!chart || !series) return;

    const pointAt = (param: MouseEventParams): TrendPoint | null => {
      if (!param.point) return null;
      // ignore clicks in the RSI sub-pane — drawings live on the price pane only
      const paneIndex = (param as { paneIndex?: number }).paneIndex;
      if (paneIndex !== undefined && paneIndex !== 0) return null;
      const price = series.coordinateToPrice(param.point.y);
      const time: Time | null = param.time ?? chart.timeScale().coordinateToTime(param.point.x);
      if (price === null || time === null) return null;
      return { time, price };
    };

    const onClick = (param: MouseEventParams) => {
      const mode = drawModeRef.current;
      if (mode === "none") return;
      const p = pointAt(param);
      if (!p) return;
      const d = drawingsFor(marketKey);
      if (mode === "hline") {
        d.hlines.push(p.price);
        applyDrawings(marketKey);
      } else if (mode === "trend") {
        if (!pendingTrendRef.current) {
          pendingTrendRef.current = p;
        } else {
          d.trends.push({ a: pendingTrendRef.current, b: p });
          pendingTrendRef.current = null;
          applyDrawings(marketKey);
        }
      }
    };

    const onMove = (param: MouseEventParams) => {
      // trendline preview while placing the second point
      if (drawModeRef.current === "trend" && pendingTrendRef.current) {
        const p = pointAt(param);
        const d = drawingsFor(marketKey);
        trendPrimRef.current?.setLines(snapTrends(d.trends), p ? { a: pendingTrendRef.current, b: p } : null);
      }
      // OHLC legend
      const bar = param.seriesData.get(series) as CandlestickData | undefined;
      if (bar && bar.open !== undefined) {
        const f = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
        setLegend(`O ${f(bar.open)}  H ${f(bar.high)}  L ${f(bar.low)}  C ${f(bar.close)}`);
      } else {
        setLegend("");
      }
    };

    chart.subscribeClick(onClick);
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeClick(onClick);
      chart.unsubscribeCrosshairMove(onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketKey]);

  // ---- entry / liq price-lines for this market's open positions ----------
  const openHere = useMemo(
    () => (positions ?? []).filter((p) => p.status === 2 && marketNameOf(p.market) === marketKey),
    [positions, marketKey]
  );
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of posLineObjsRef.current) series.removePriceLine(l);
    posLineObjsRef.current = [];
    if (!xrpPx) return;
    for (const p of openHere) {
      const entry = Number(p.entryPrice6) / 1e6;
      if (entry <= 0) continue;
      const size = Number(p.sizeUsd6) / 1e6;
      const marginUsd = (Number(p.marginFxrp) / 1e6) * (Number(xrpPx) / 1e6);
      if (size <= 0) continue;
      const liq = p.isLong
        ? entry * (1 + MAINTENANCE - marginUsd / size)
        : entry * (1 - MAINTENANCE + marginUsd / size);
      posLineObjsRef.current.push(
        series.createPriceLine({
          price: entry,
          color: p.isLong ? "#3add9a" : "#ff5470",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: `#${p.id} entry`,
        })
      );
      if (liq > 0) {
        posLineObjsRef.current.push(
          series.createPriceLine({
            price: liq,
            color: "#ff5470",
            lineWidth: 1,
            lineStyle: LineStyle.SparseDotted,
            title: `#${p.id} liq`,
          })
        );
      }
    }
  }, [openHere, xrpPx, marketKey, tf]);

  // ---- UI ----------------------------------------------------------------
  const toggle = (k: keyof Toggles) => setTogg((t) => ({ ...t, [k]: !t[k] }));
  const srcLabel =
    source === "hl"
      ? `history: Hyperliquid ${marketKey} (mainnet) · live candle: FTSOv2 mark`
      : `live off the FTSOv2 mark · synthetic warm-up history (testnet feed level)`;

  return (
    <div>
      <div className="chart-head">
        <span className="px">{mark !== undefined ? `$${fmtPx(mark)}` : "..."}</span>
        <span className="sub">
          {marketKey}-PERP · {srcLabel}
        </span>
        {legend && <span className="ohlc">{legend}</span>}
      </div>
      <div className="chart-tools">
        <div className="ctl-group">
          {TIMEFRAMES.map((t) => (
            <button key={t} className={`ctl ${tf === t ? "on" : ""}`} onClick={() => setTf(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="ctl-group">
          <button className={`ctl ${togg.ema ? "on" : ""}`} onClick={() => toggle("ema")} title={`EMA ${EMA_PERIOD}`}>
            EMA
          </button>
          <button className={`ctl ${togg.sma ? "on" : ""}`} onClick={() => toggle("sma")} title={`SMA ${SMA_PERIOD}`}>
            SMA
          </button>
          <button className={`ctl ${togg.bb ? "on" : ""}`} onClick={() => toggle("bb")} title="Bollinger 20, 2σ">
            BB
          </button>
          <button className={`ctl ${togg.rsi ? "on" : ""}`} onClick={() => toggle("rsi")} title="RSI 14">
            RSI
          </button>
        </div>
        <div className="ctl-group">
          <button
            className={`ctl ${drawMode === "hline" ? "on" : ""}`}
            onClick={() => setDrawMode((m) => (m === "hline" ? "none" : "hline"))}
            title="Horizontal line: click the chart to place"
          >
            ─
          </button>
          <button
            className={`ctl ${drawMode === "trend" ? "on" : ""}`}
            onClick={() => {
              pendingTrendRef.current = null;
              setDrawMode((m) => (m === "trend" ? "none" : "trend"));
            }}
            title="Trendline: click two points"
          >
            ╱
          </button>
          <button className="ctl" onClick={clearDrawings} title="Clear drawings">
            ✕
          </button>
        </div>
      </div>
      <div ref={boxRef} className={`chartbox ${drawMode !== "none" ? "drawing" : ""}`} />
    </div>
  );
}

// bytes32 -> ascii market key (local copy to avoid a hooks import cycle)
function marketNameOf(id: `0x${string}`): string {
  let out = "";
  for (let i = 2; i < id.length; i += 2) {
    const code = parseInt(id.slice(i, i + 2), 16);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}
