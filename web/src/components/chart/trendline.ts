import type {
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

export type TrendPoint = { time: Time; price: number };
export type Trendline = { a: TrendPoint; b: TrendPoint };

/** Minimal two-point trendline overlay for lightweight-charts v5.
 * Lines are stored in chart (time, price) space and re-projected every paint,
 * so they stay pinned through pan/zoom/timeframe scrolling. */
export class TrendlinesPrimitive implements ISeriesPrimitive<Time> {
  private lines: Trendline[] = [];
  private preview: Trendline | null = null;
  private param: SeriesAttachedParameter<Time> | null = null;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.param = param;
  }
  detached(): void {
    this.param = null;
  }

  setLines(lines: Trendline[], preview: Trendline | null = null): void {
    this.lines = lines;
    this.preview = preview;
    this.param?.requestUpdate();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    const param = this.param;
    if (!param) return [];
    const chart = param.chart;
    const series = param.series;
    const toXY = (p: TrendPoint): { x: number; y: number } | null => {
      const x = chart.timeScale().timeToCoordinate(p.time);
      const y = series.priceToCoordinate(p.price);
      return x === null || y === null ? null : { x, y };
    };
    const segments: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; dashed: boolean }> = [];
    for (const l of this.lines) {
      const a = toXY(l.a);
      const b = toXY(l.b);
      if (a && b) segments.push({ a, b, dashed: false });
    }
    if (this.preview) {
      const a = toXY(this.preview.a);
      const b = toXY(this.preview.b);
      if (a && b) segments.push({ a, b, dashed: true });
    }
    const renderer: IPrimitivePaneRenderer = {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context: ctx }: { context: CanvasRenderingContext2D }) => {
          for (const s of segments) {
            ctx.save();
            ctx.strokeStyle = "#ffc24b";
            ctx.lineWidth = 1.5;
            ctx.setLineDash(s.dashed ? [4, 4] : []);
            ctx.beginPath();
            ctx.moveTo(s.a.x, s.a.y);
            ctx.lineTo(s.b.x, s.b.y);
            ctx.stroke();
            ctx.restore();
          }
        });
      },
    };
    const view: IPrimitivePaneView = { renderer: () => renderer };
    return [view];
  }
}
