import { BAYER } from "@/components/dither-kit/dither-paint";
import { PALETTE, type DitherColor } from "@/components/dither-kit/palette";
import {
  BAND_HEIGHT,
  BAND_TOPS,
  BASE_TOP,
  RING_PATH,
} from "@/components/ui/logo";

/**
 * The overview poster: a 1200×630 picture of the numbers on screen, drawn on
 * a canvas in the customer's own browser (feature_candidates §6).
 *
 * Not a screenshot, on purpose. The dashboard is exactly the kind of page
 * DOM-to-image libraries fail on (squircle clip paths, backdrop blur, a
 * palette in `oklch()` and `color-mix()`), and a card cropped out of a
 * dashboard is a poor social image anyway: it carries scroll edges, hover
 * affordances and whatever size the grid happened to give it. So this draws
 * a purpose-built composition from the same numbers the cards already hold,
 * at one fixed size, in the product's own type and mark.
 *
 * Pure: no React, no fetch, no DOM beyond the context it is handed. The
 * modal assembles a `PosterModel` from what the cards have already rendered
 * and asks this to draw it; the preview and the downloaded file come off the
 * same canvas, which is what makes "the modal shows exactly what you get" a
 * structural fact rather than a promise.
 */

export const POSTER_WIDTH = 1200;
export const POSTER_HEIGHT = 630;
/**
 * Fixed backing scale, never the screen's own `devicePixelRatio`: the file
 * is 2400×1260 whether it was made on a phone or a retina desktop, so two
 * people sharing the same range produce the same bytes.
 */
export const POSTER_SCALE = 2;

/** The dither palette's six series colours; grey is the no-data tone. */
export const POSTER_COLORS = [
  "blue",
  "green",
  "purple",
  "pink",
  "orange",
  "red",
] as const satisfies readonly DitherColor[];
export type PosterColor = (typeof POSTER_COLORS)[number];

export type PosterTheme = "light" | "dark";

/** The stat row's figures a poster can carry, in the order they are drawn. */
export const POSTER_METRICS = [
  "visitors",
  "pageviews",
  "bounce",
  "revenue",
] as const;
export type PosterMetricKey = (typeof POSTER_METRICS)[number];

export type PosterMetric = {
  key: PosterMetricKey;
  label: string;
  /** Already formatted, by the same code the stat card uses. */
  value: string;
};

export type PosterModel = {
  site: {
    name: string;
    /** The site's own favicon, or null for the initial tile. */
    favicon: CanvasImageSource | null;
  };
  period: {
    /** "Last 30 days", the picker's own words. */
    label: string;
    /** "Aug 3 to Sep 1, 2026", in the range's zone. */
    dates: string;
  };
  /** The figures chosen and available, in display order. */
  metrics: readonly PosterMetric[];
  /** Visitors per bucket, exactly as the chart plotted them. */
  series: readonly number[];
  /** "Source: Google · Country: Germany", or null when nothing filters. */
  filters: string | null;
};

export type PosterLook = {
  theme: PosterTheme;
  color: PosterColor;
  chart: boolean;
  hideSite: boolean;
};

const BRAND_NAME = "Open Analytics";
const BRAND_DOMAIN = "getopen.so";

const MARGIN = 72;
const RIGHT = POSTER_WIDTH - MARGIN;
const CONTENT_WIDTH = RIGHT - MARGIN;
/** The chart owns the bottom band edge to edge; no inset, no axis. */
const CHART_TOP = 384;
const CHART_CELL = 4;

type Palette = {
  ground: string;
  ink: string;
  muted: string;
  pill: string;
  /** The initial tile when a site has no favicon: the brand primary. */
  tile: string;
  /** Our mark: the primary on the light ground, as the header wears it;
   * ink on the dark one, where the mark reads as a mark and not a badge. */
  mark: string;
};

/** The product's own tokens (`globals.css`), stated here because a canvas
 * cannot read CSS variables and the file must not depend on the page's
 * theme: a dark-mode user still gets a light poster when they ask for one. */
const THEMES: Record<PosterTheme, Palette> = {
  light: {
    ground: "#f6f6f6",
    ink: "#292929",
    muted: "#6d6d6d",
    pill: "rgba(41,41,41,0.06)",
    tile: "#305dde",
    mark: "#305dde",
  },
  dark: {
    ground: "#191919",
    ink: "#ededed",
    muted: "#969696",
    pill: "rgba(237,237,237,0.08)",
    tile: "#296ff0",
    mark: "#ededed",
  },
};

function font(weight: number, size: number, family: string): string {
  return `${weight} ${size}px ${family}`;
}

/** The brand mark, from the same geometry `Logo` renders. */
function drawMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 512, size / 512);
  ctx.clip(new Path2D(RING_PATH), "evenodd");
  ctx.fillStyle = color;
  for (const top of BAND_TOPS) ctx.fillRect(0, top, 512, BAND_HEIGHT);
  ctx.fillRect(0, BASE_TOP, 512, 512 - BASE_TOP);
  ctx.restore();
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function text(
  ctx: CanvasRenderingContext2D,
  value: string,
  x: number,
  y: number,
  fontSpec: string,
  color: string,
  align: CanvasTextAlign = "left",
  spacing = "0px"
): void {
  ctx.font = fontSpec;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.letterSpacing = spacing;
  ctx.fillText(value, x, y);
}

/**
 * The dither-kit column paint, transposed to a fixed composition: solid at
 * the floor, dissolving toward the value line, a soft outline on top. Same
 * Bayer matrix, same density-to-alpha rule, so the poster's chart is
 * recognisably the dashboard's.
 */
function ditherArea(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  series: readonly number[],
  color: PosterColor
): void {
  const [r, g, b] = PALETTE[color].fill;
  const paint = (alpha: number) => `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  const max = Math.max(...series, 1) * 1.12;
  const cols = Math.floor(width / CHART_CELL);
  const floorRow = Math.round((y + height) / CHART_CELL);
  const last = series.length - 1;
  for (let c = 0; c < cols; c++) {
    const t = (c / Math.max(cols - 1, 1)) * last;
    const i = Math.floor(t);
    const f = t - i;
    const value =
      i >= last ? series[last] : series[i] * (1 - f) + series[i + 1] * f;
    const top = y + height - (value / max) * height;
    const topRow = Math.round(top / CHART_CELL);
    const depth = Math.max(floorRow - topRow, 1);
    const cx = x + c * CHART_CELL;
    for (let row = topRow; row < floorRow; row++) {
      const density = (row - topRow) / depth;
      const lit = density > BAYER[row & 3][c & 3];
      const k = 0.3 + density * 0.7;
      ctx.fillStyle = paint(lit ? k : k * 0.4);
      ctx.fillRect(cx, row * CHART_CELL, CHART_CELL, CHART_CELL);
    }
    ctx.fillStyle = paint(0.72);
    ctx.fillRect(cx, topRow * CHART_CELL, CHART_CELL, CHART_CELL);
    ctx.fillStyle = paint(0.36);
    ctx.fillRect(cx, (topRow + 1) * CHART_CELL, CHART_CELL, CHART_CELL);
  }
}

function siteTile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  site: PosterModel["site"],
  palette: Palette,
  family: string
): void {
  ctx.save();
  roundedRect(ctx, x, y, size, size, size * 0.28);
  if (site.favicon) {
    ctx.clip();
    ctx.drawImage(site.favicon, x, y, size, size);
  } else {
    ctx.fillStyle = palette.tile;
    ctx.fill();
    const initial = site.name.trim().charAt(0).toUpperCase() || "?";
    text(
      ctx,
      initial,
      x + size / 2,
      y + size * 0.69,
      font(500, size * 0.58, family),
      "#ffffff",
      "center"
    );
  }
  ctx.restore();
}

/**
 * Draws the whole poster into `ctx`, which must belong to a canvas of
 * `POSTER_WIDTH × POSTER_SCALE` by `POSTER_HEIGHT × POSTER_SCALE`. `family`
 * is the page's own sans family, loaded beforehand (`ensurePosterFonts`);
 * a canvas will not wait for a font the way the DOM does.
 */
export function drawOverviewPoster(
  ctx: CanvasRenderingContext2D,
  model: PosterModel,
  look: PosterLook,
  family: string
): void {
  const palette = THEMES[look.theme];
  ctx.setTransform(POSTER_SCALE, 0, 0, POSTER_SCALE, 0, 0);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = palette.ground;
  ctx.fillRect(0, 0, POSTER_WIDTH, POSTER_HEIGHT);

  // The site's brand, top-left, with the period under it. Hidden, the
  // period takes the title line: the image still says what it measures.
  let periodBottom: number;
  if (look.hideSite) {
    text(
      ctx,
      model.period.label,
      MARGIN,
      86,
      font(500, 26, family),
      palette.ink,
      "left",
      "-0.3px"
    );
    text(
      ctx,
      model.period.dates,
      MARGIN,
      118,
      font(400, 18, family),
      palette.muted
    );
    periodBottom = 118;
  } else {
    siteTile(ctx, MARGIN, 56, 40, model.site, palette, family);
    text(
      ctx,
      model.site.name,
      MARGIN + 52,
      86,
      font(500, 26, family),
      palette.ink,
      "left",
      "-0.3px"
    );
    text(
      ctx,
      `${model.period.label} · ${model.period.dates}`,
      MARGIN,
      118,
      font(400, 18, family),
      palette.muted
    );
    periodBottom = 118;
  }

  // Always printed while a filter is on. Filtered visitors under an
  // unqualified headline would present one population as the whole site.
  if (model.filters) {
    const label = `Filtered · ${model.filters}`;
    ctx.font = font(400, 16, family);
    const width = ctx.measureText(label).width + 28;
    const top = periodBottom + 20;
    roundedRect(ctx, MARGIN, top, width, 30, 15);
    ctx.fillStyle = palette.pill;
    ctx.fill();
    text(
      ctx,
      label,
      MARGIN + 14,
      top + 21,
      font(400, 16, family),
      palette.ink
    );
  }

  // Our brand, top-right, on the same measures as the site's: a 40px mark
  // beside a 26px name, the domain under it on the period line's baseline.
  ctx.font = font(500, 26, family);
  ctx.letterSpacing = "-0.3px";
  const brandWidth = ctx.measureText(BRAND_NAME).width;
  drawMark(ctx, RIGHT - brandWidth - 52, 56, 40, palette.mark);
  text(
    ctx,
    BRAND_NAME,
    RIGHT,
    86,
    font(500, 26, family),
    palette.ink,
    "right",
    "-0.3px"
  );
  text(
    ctx,
    BRAND_DOMAIN,
    RIGHT,
    118,
    font(400, 18, family),
    palette.muted,
    "right"
  );

  // The figures share the width evenly; fewer of them get bigger type, and
  // without a chart they drop to the vertical centre of what is left.
  const count = model.metrics.length;
  if (count > 0) {
    const size = count <= 2 ? 92 : count === 3 ? 76 : 64;
    const labelY = look.chart ? 232 : 336;
    const valueY = labelY + size * 0.92;
    const column = CONTENT_WIDTH / count;
    model.metrics.forEach((metric, index) => {
      const x = MARGIN + index * column;
      text(
        ctx,
        metric.label.toUpperCase(),
        x,
        labelY,
        font(500, 14, family),
        palette.muted,
        "left",
        "1.6px"
      );
      text(
        ctx,
        metric.value,
        x,
        valueY,
        font(500, size, family),
        palette.ink,
        "left",
        `${-size / 60}px`
      );
    });
  }

  if (look.chart && model.series.length >= 2) {
    ditherArea(
      ctx,
      0,
      CHART_TOP,
      POSTER_WIDTH,
      POSTER_HEIGHT - CHART_TOP,
      model.series,
      look.color
    );
  }
}

/** `kanba-co-last-30-days.png`: the site and the range, nothing else. */
export function posterFileName(siteName: string, periodLabel: string): string {
  const slug = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const parts = [slug(siteName), slug(periodLabel)].filter(
    (part) => part !== ""
  );
  return `${parts.join("-") || "overview"}.png`;
}
