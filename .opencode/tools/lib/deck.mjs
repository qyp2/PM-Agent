/**
 * Slide design engine.
 *
 * Everything that decides how a slide *looks* lives here: palette derivation
 * from the master theme, a text-fit engine, a small component library
 * (cards, rules, chips, tables, chevrons) and per-layout composers.
 *
 * `pptx.mjs` only owns packaging (zip parts, master copying, layout wiring).
 *
 * Coordinates are inches (floats) throughout; XML emission converts to EMU.
 */
import { xmlEscape } from "./shared.mjs";

export const IN = 914400;
const PT = 12700;
const emu = (inches) => Math.round(inches * IN);
const pts = (points) => Math.round(points * PT);

/* ------------------------------------------------------------------ color */

const clamp = (v, min = 0, max = 255) => Math.min(max, Math.max(min, v));

function parseHex(value) {
  const text = String(value ?? "").replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return [
    Number.parseInt(text.slice(0, 2), 16),
    Number.parseInt(text.slice(2, 4), 16),
    Number.parseInt(text.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]) {
  const part = (v) => clamp(Math.round(v)).toString(16).padStart(2, "0").toUpperCase();
  return `${part(r)}${part(g)}${part(b)}`;
}

export const normalizeColor = (value, fallback = "000000") =>
  parseHex(value) ? toHex(parseHex(value)) : fallback;

/** Blend `color` toward white by `ratio` (0 = color, 1 = white). */
export function tint(color, ratio = 0.9) {
  const rgb = parseHex(color) ?? [0, 0, 0];
  const t = Math.min(1, Math.max(0, ratio));
  return toHex(rgb.map((v) => v + (255 - v) * t));
}

/** Multiply `color` toward black by `ratio` (0 = color, 1 = black). */
export function shade(color, ratio = 0.25) {
  const rgb = parseHex(color) ?? [0, 0, 0];
  const t = Math.min(1, Math.max(0, ratio));
  return toHex(rgb.map((v) => v * (1 - t)));
}

function luminance(color) {
  const rgb = parseHex(color) ?? [255, 255, 255];
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readable(color, background = "FFFFFF", minRatio = 3.2) {
  const bgLum = luminance(background);
  let current = color;
  for (let step = 0; step < 8; step += 1) {
    const lum = luminance(current);
    const ratio =
      (Math.max(lum, bgLum) + 0.05) / (Math.min(lum, bgLum) + 0.05);
    if (ratio >= minRatio) return current;
    current = shade(current, 0.12);
  }
  return current;
}

function parseThemeColors(themeXml) {
  const scheme = themeXml?.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/)?.[0] ?? "";
  const colors = {};
  for (const match of scheme.matchAll(
    /<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>([\s\S]*?)<\/a:\1>/g,
  )) {
    const name = match[1];
    const body = match[2];
    const srgb = body.match(/<a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1];
    const sys = body.match(/lastClr="([0-9A-Fa-f]{6})"/)?.[1];
    if (srgb || sys) colors[name] = (srgb || sys).toUpperCase();
  }
  return colors;
}

function parseThemeFonts(themeXml) {
  const fontOf = (tag) => {
    const block = themeXml?.match(new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`))?.[1] ?? "";
    const latin = block.match(/<a:latin typeface="([^"]*)"/)?.[1] ?? "";
    const ea = block.match(/<a:ea typeface="([^"]*)"/)?.[1] ?? "";
    const hans = block.match(/<a:font script="Hans" typeface="([^"]*)"/)?.[1] ?? "";
    return { latin, ea: ea || hans };
  };
  return { major: fontOf("majorFont"), minor: fontOf("minorFont") };
}

/**
 * Derive the working palette.
 * Priority: master catalog theme (brand overrides) → theme1.xml → defaults.
 */
export function buildPalette({ themeXml = "", brand = null } = {}) {
  const scheme = parseThemeColors(themeXml);
  const primary = normalizeColor(brand?.primary ?? scheme.accent1 ?? "4F46E5");
  const accent = normalizeColor(brand?.accent ?? primary);
  const ink = normalizeColor(brand?.ink ?? scheme.dk2 ?? scheme.dk1 ?? "1E293B");
  const body = normalizeColor(brand?.body ?? tint(ink, 0.32));
  const muted = readable(normalizeColor(brand?.muted ?? tint(ink, 0.55)), "FFFFFF", 4.5);
  const bodyText = readable(body, "FFFFFF", 7.0);
  return {
    primary,
    accent,
    ink,
    body: bodyText,
    muted,
    white: "FFFFFF",
    surface: tint(primary, 0.965),
    surfaceAlt: tint(primary, 0.93),
    band: tint(primary, 0.86),
    border: tint(primary, 0.88),
    rule: tint(ink, 0.78),
    onAccent: "FFFFFF",
    chipText: shade(primary, 0.15),
  };
}

export function buildFonts({ themeXml = "", brand = null } = {}) {
  const theme = parseThemeFonts(themeXml);
  const cjkFallback = "Microsoft YaHei";
  const pick = (...values) => values.find((value) => value && value.trim() !== "") ?? cjkFallback;
  return {
    title: pick(brand?.fontEastAsia, theme.major.ea, theme.major.latin, cjkFallback),
    body: pick(brand?.fontEastAsia, theme.minor.ea, theme.minor.latin, cjkFallback),
    latin: pick(brand?.fontLatin, theme.minor.latin, "Calibri"),
  };
}

/* --------------------------------------------------------------- measure */

const CJK =
  /[\u1100-\u11FF\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

function charEm(ch) {
  const code = ch.codePointAt(0);
  if (code === 32) return 0.3;
  if (CJK.test(ch)) return 1;
  if (code < 0x20) return 0;
  if (/[0-9]/.test(ch)) return 0.56;
  if (/[A-Z]/.test(ch)) return 0.68;
  if (/[a-z]/.test(ch)) return 0.53;
  if (/[.,:;'"!|`]/.test(ch)) return 0.3;
  if (/[()[\]{}/\\\-+=<>~^]/.test(ch)) return 0.42;
  if (/[%$#@&*]/.test(ch)) return 0.62;
  return 0.6;
}

export function textWidthEm(text) {
  let total = 0;
  for (const ch of String(text ?? "")) total += charEm(ch);
  return total;
}

function tokenize(text) {
  const tokens = [];
  let word = "";
  for (const ch of String(text ?? "")) {
    if (CJK.test(ch) || ch === " ") {
      if (word) {
        tokens.push(word);
        word = "";
      }
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) tokens.push(word);
  return tokens;
}

/** Greedy line wrap; returns the number of lines at `size` points. */
export function countLines(text, widthIn, size) {
  const width = Math.max(1, widthIn * 72);
  const tokens = tokenize(text);
  if (tokens.length === 0) return 1;
  let lines = 1;
  let used = 0;
  for (const token of tokens) {
    const tokenWidth = textWidthEm(token) * size;
    if (used + tokenWidth <= width) {
      used += tokenWidth;
      continue;
    }
    if (token === " " && used === 0) continue;
    lines += 1;
    used = 0;
    if (tokenWidth > width) {
      // Long unbroken run: account for the hard-wrapped remainder.
      const extra = Math.ceil(tokenWidth / width) - 1;
      lines += extra;
      used = tokenWidth - extra * width;
    } else {
      used = tokenWidth;
    }
  }
  return lines;
}

/** Measured height in inches for a text block. */
export function textHeightIn(text, widthIn, size, lineFactor = 1.32) {
  // 4% slack: CJK advances are exactly 1em so the estimate is tight, but the
  // Latin part of a line still varies a little between font builds.
  return (countLines(text, widthIn, size) * size * lineFactor * 1.04) / 72;
}

/**
 * Largest font size (points) at which every text block fits the box.
 * Returns `{ size, height, fits }`; `fits === false` means content overflows
 * even at `min` and the caller should warn.
 */
export function fitSize(texts, options = {}) {
  const {
    widthIn,
    heightIn,
    max = 24,
    min = 12,
    step = 1,
    lineFactor = 1.32,
    gapIn = 0,
  } = options;
  const blocks = texts.filter((text) => String(text ?? "").trim() !== "");
  if (blocks.length === 0) return { size: max, height: 0, fits: true };
  for (let size = max; size >= min; size -= step) {
    const height =
      blocks.reduce(
        (sum, text) => sum + textHeightIn(text, widthIn, size, lineFactor),
        0,
      ) +
      gapIn * (blocks.length - 1);
    if (height <= heightIn) return { size, height, fits: true };
  }
  const height =
    blocks.reduce((sum, text) => sum + textHeightIn(text, widthIn, min, lineFactor), 0) +
    gapIn * (blocks.length - 1);
  return { size: min, height, fits: height <= heightIn };
}

/* ------------------------------------------------------------- descriptors */

const RUN_KEYS = ["size", "bold", "italic", "color", "font"];
const PARA_KEYS = [
  "align",
  "lineSpacingPercent",
  "spaceBeforePt",
  "spaceAfterPt",
  "marLIn",
  "indentIn",
  "bullet",
];

/**
 * One paragraph of one run. Paragraph-level options (align, spacing, bullet)
 * are split out of the run so `a:rPr` never receives unknown attributes.
 */
export const text = (value, style = {}) => {
  const run = { text: String(value ?? "") };
  for (const key of RUN_KEYS) if (style[key] !== undefined) run[key] = style[key];
  const paragraph = { runs: [run], align: style.align ?? "l" };
  for (const key of PARA_KEYS) {
    if (style[key] !== undefined) paragraph[key] = style[key];
  }
  return paragraph;
};

function runXml(run, ctx) {
  const size = Math.round((run.size ?? 18) * 100);
  const attrs = [
    `lang="zh-CN"`,
    `sz="${size}"`,
    run.bold ? `b="1"` : "",
    run.italic ? `i="1"` : "",
    `dirty="0"`,
  ]
    .filter(Boolean)
    .join(" ");
  const color = normalizeColor(run.color ?? ctx.palette.body);
  const font = run.font ?? ctx.fonts.body;
  return `<a:r><a:rPr ${attrs}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${xmlEscape(
    font,
  )}"/><a:ea typeface="${xmlEscape(font)}"/><a:cs typeface="${xmlEscape(font)}"/></a:rPr><a:t xml:space="preserve">${xmlEscape(
    run.text,
  )}</a:t></a:r>`;
}

function paragraphXml(descriptor, ctx) {
  const align = descriptor.align === "ctr" || descriptor.align === "r" ? descriptor.align : "l";
  const marL = descriptor.marLIn ? ` marL="${emu(descriptor.marLIn)}"` : "";
  const indent = descriptor.indentIn !== undefined ? ` indent="${emu(descriptor.indentIn)}"` : "";
  const parts = [];
  parts.push(`<a:pPr algn="${align}"${marL}${indent}>`);
  if (descriptor.lineSpacingPercent) {
    // Absolute line spacing in points: `a:spcPct` scales the font's (renderer
    // specific) single line height, so PowerPoint, WPS and LibreOffice all end
    // up with different line heights than the ones measured here. `a:spcPts`
    // is honoured verbatim by every renderer, which keeps the measured boxes
    // and the rendered glyphs in sync.
    const size = descriptor.runs[0]?.size ?? 18;
    const linePts = (size * descriptor.lineSpacingPercent) / 100;
    parts.push(`<a:lnSpc><a:spcPts val="${Math.round(linePts * 100)}"/></a:lnSpc>`);
  }
  if (descriptor.spaceBeforePt) {
    // `a:spcPts` is hundredths of a point for spacing too; `pts()` converts to
    // EMU (12700/pt) and would emit 127× the intended gap, pushing text far
    // outside its box.
    parts.push(`<a:spcBef><a:spcPts val="${Math.round(descriptor.spaceBeforePt * 100)}"/></a:spcBef>`);
  }
  if (descriptor.spaceAfterPt) {
    parts.push(`<a:spcAft><a:spcPts val="${Math.round(descriptor.spaceAfterPt * 100)}"/></a:spcAft>`);
  }
  const bullet = descriptor.bullet;
  if (bullet) {
    parts.push(
      `<a:buClr><a:srgbClr val="${normalizeColor(bullet.color ?? ctx.palette.accent)}"/></a:buClr>`,
    );
    parts.push(`<a:buFont typeface="${xmlEscape(bullet.font ?? "Arial")}"/>`);
    parts.push(`<a:buChar char="${xmlEscape(bullet.char ?? "•")}"/>`);
  } else {
    parts.push("<a:buNone/>");
  }
  parts.push("</a:pPr>");
  const runs = descriptor.runs.map((run) => runXml(run, ctx)).join("");
  return `<a:p>${parts.join("")}${runs}</a:p>`;
}

function textBodyXml(descriptor, ctx) {
  const insets = descriptor.insets ?? {};
  const anchor = descriptor.anchor ?? "t";
  const wrap = descriptor.wrap ?? "square";
  // Boxes are sized from the measured text, so autofit is pinned to
  // `noAutofit`: `normAutofit` lets each renderer shrink a different box by a
  // different amount, which is how decks end up with mismatched sizes page to
  // page. Sizes must be identical on every machine instead.
  const bodyPr = `<a:bodyPr wrap="${wrap}" lIns="${emu(insets.left ?? 0)}" tIns="${emu(
    insets.top ?? 0,
  )}" rIns="${emu(insets.right ?? 0)}" bIns="${emu(insets.bottom ?? 0)}" rtlCol="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr>`;
  return `<p:txBody>${bodyPr}<a:lstStyle/>${descriptor.paras
    .map((item) => paragraphXml(item, ctx))
    .join("")}</p:txBody>`;
}

function fillXml(fill) {
  if (!fill) return "<a:noFill/>";
  const color = normalizeColor(fill.color ?? fill);
  const alpha = fill.alpha;
  return `<a:solidFill><a:srgbClr val="${color}">${
    alpha !== undefined ? `<a:alpha val="${Math.round(alpha * 1000)}"/>` : ""
  }</a:srgbClr></a:solidFill>`;
}

function lineXml(line) {
  if (!line) return "<a:ln><a:noFill/></a:ln>";
  const color = normalizeColor(line.color ?? line);
  const width = line.width ?? 1;
  const dash = line.dash ? `<a:prstDash val="${line.dash}"/>` : "";
  return `<a:ln w="${pts(width)}" cap="flat">${fillXml({ color })}${dash}</a:ln>`;
}

function geometryXml(shape) {
  const prst = shape.geom ?? "rect";
  const adj =
    shape.adj === undefined
      ? ""
      : `<a:avLst><a:gd name="adj" fmla="val ${Math.round(shape.adj)}"/></a:avLst>`;
  return `<a:prstGeom prst="${prst}"><a:avLst>${adj}</a:avLst></a:prstGeom>`;
}

function xfrmXml(box) {
  return `<a:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(box.w)}" cy="${emu(
    box.h,
  )}"/></a:xfrm>`;
}

function shapeXml(shape, id, ctx) {
  const name = xmlEscape(shape.name ?? "Shape");
  if (shape.t === "ph") {
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${shape.phAttrs}/></p:nvPr></p:nvSpPr><p:spPr>${xfrmXml(
      shape.box,
    )}${geometryXml(shape)}${fillXml(shape.fill)}${lineXml(shape.line)}</p:spPr>${textBodyXml(shape, ctx)}</p:sp>`;
  }
  if (shape.t === "table") return tableXml(shape, id, ctx);
  const txBox = shape.paras ? ` txBox="1"` : "";
  const body = shape.paras ? textBodyXml(shape, ctx) : "";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr${txBox}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrmXml(
    shape.box,
  )}${geometryXml(shape)}${fillXml(shape.fill)}${lineXml(shape.line)}</p:spPr>${body}</p:sp>`;
}

function cellXml(cell, ctx) {
  const fill = cell.fill ? fillXml(cell.fill) : "";
  const anchor = cell.anchor ?? "ctr";
  const marginX = cell.marginX ?? 0.1;
  const tcPr = `<a:tcPr marL="${emu(marginX)}" marR="${emu(marginX)}" marT="${emu(0.04)}" marB="${emu(
    0.04,
  )}" anchor="${anchor}">${fill}${
    cell.borderBottom
      ? `<a:lnB w="${pts(cell.borderBottom.width ?? 0.6)}" cap="flat"><a:solidFill><a:srgbClr val="${normalizeColor(
          cell.borderBottom.color,
        )}"/></a:solidFill></a:lnB>`
      : ""
  }</a:tcPr>`;
  const paragraphs = cell.paras.length
    ? cell.paras.map((item) => paragraphXml(item, ctx)).join("")
    : '<a:p><a:endParaRPr lang="zh-CN" sz="1200"/></a:p>';
  const body = `<a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</a:txBody>`;
  return `<a:tc>${body}${tcPr}</a:tc>`;
}

function tableXml(shape, id, ctx) {
  const grid = shape.cols.map((w) => `<a:gridCol w="${emu(w)}"/>`).join("");
  const rows = shape.rows
    .map(
      (row) =>
        `<a:tr h="${emu(row.h)}">${row.cells.map((cell) => cellXml(cell, ctx)).join("")}</a:tr>`,
    )
    .join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${xmlEscape(
    shape.name ?? "Table",
  )}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(
    shape.box.x,
  )}" y="${emu(shape.box.y)}"/><a:ext cx="${emu(shape.box.w)}" cy="${emu(
    shape.box.h,
  )}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** Serialize descriptors to `<p:sp>` / `<p:graphicFrame>` XML with unique ids. */
export function renderShapes(shapes, ctx, startId = 2) {
  let id = startId;
  return shapes
    .map((shape) => shapeXml(shape, id++, ctx))
    .join("");
}

/* --------------------------------------------------------------- helpers */

const box = (x, y, w, h) => ({ x, y, w, h });
const insetBox = (b, dx, dy) => box(b.x + dx, b.y + dy, b.w - dx * 2, b.h - dy * 2);

function titleDescriptor(ctx, value, options = {}) {
  const {
    size = 24,
    min = 16,
    color = ctx.palette.primary,
    bold = true,
    box: target = ctx.regions.title,
    maxLines = null,
    align = "l",
  } = options;
  const area = target ?? ctx.regions.area;
  const width = Math.max(1, area.w - (options.inset ?? 0.02));
  const fit = fitSize([value], {
    widthIn: width,
    heightIn: Math.max(0.3, area.h),
    max: size,
    min,
    lineFactor: 1.2,
  });
  return { size: fit.size, width, maxLines };
}

/**
 * Build the slide title as a layout placeholder when the layout provides one
 * (keeps the deck editable and on-brand), otherwise as a styled text box.
 * Height grows downward into the gap above the body when the title wraps.
 */
function titleShape(ctx, value, options = {}) {
  const target = options.box ?? ctx.regions.title ?? ctx.regions.area;
  const area = ctx.regions.area;
  const maxSize = options.size ?? 24;
  const minSize = options.min ?? 16;
  const color = options.color ?? ctx.palette.primary;
  const align = options.align ?? "l";
  const inner = { x: target.x + 0.02, y: target.y, w: target.w - 0.04, h: target.h };
  const floor = area.y - 0.08;
  let chosen = null;
  for (let size = maxSize; size >= minSize; size -= 1) {
    const lines = countLines(value, inner.w - 0.02, size);
    const height = (lines * size * 1.2) / 72;
    if (height <= Math.max(target.h, floor - target.y)) {
      chosen = { size, lines, height };
      break;
    }
  }
  if (!chosen) {
    const size = minSize;
    const lines = countLines(value, inner.w, size);
    chosen = { size, lines, height: (lines * size * 1.2) / 72 };
    ctx.warn(`标题过长（${String(value).length} 字），已缩至 ${size}pt 并可能占用两行`);
  }
  const height = Math.max(target.h, Math.min(chosen.height + 0.06, Math.max(target.h, floor - target.y)));
  const finalBox = { x: inner.x, y: target.y, w: inner.w, h: height };
  if (chosen.lines > 1) {
    ctx.warn(`标题「${String(value).slice(0, 14)}…」占 ${chosen.lines} 行，建议压缩到 20 字以内`);
  }
  // A wrapped title (two lines) hugs the bottom of its band so it never drifts
  // toward the page edge or collides with the logo row.
  const anchor = height > target.h + 0.02 ? "b" : "ctr";
  const paras = [
    text(value, {
      size: chosen.size,
      bold: options.bold ?? true,
      color,
      font: ctx.fonts.title,
      align,
    }),
  ];
  if (ctx.layout.titlePh) {
    return [
      {
        t: "ph",
        name: "Title",
        phAttrs: ctx.layout.titlePh,
        box: finalBox,
        paras,
        anchor,
        insets: { left: 0.02, right: 0.02 },
        autofit: false,
      },
    ];
  }
  const out = [
    {
      t: "sp",
      name: "Title",
      box: finalBox,
      paras,
      anchor,
      autofit: false,
    },
  ];
  if (ctx.layout.hasArt === false) {
    out.push({
      t: "sp",
      name: "Title rule",
      box: box(finalBox.x, finalBox.y + finalBox.h + 0.1, 1.05, 0.06),
      fill: ctx.palette.primary,
    });
  }
  return out;
}

function kickerShape(ctx, label, b) {
  const size = 12;
  const width = Math.max(0.9, textWidthEm(label) * size / 72 + 0.34);
  return [
    {
      t: "sp",
      name: "Kicker",
      box: box(b.x, b.y, width, 0.28),
      geom: "roundRect",
      adj: 50000,
      fill: ctx.palette.surfaceAlt,
    },
    {
      t: "sp",
      name: "Kicker text",
      box: box(b.x + 0.12, b.y - 0.01, width - 0.2, 0.3),
      paras: [text(label, { size, bold: true, color: ctx.palette.chipText, font: ctx.fonts.body })],
      anchor: "ctr",
      autofit: false,
    },
  ];
}

function countWarning(ctx, label, count, max) {
  if (count > max) ctx.warn(`${label} 共 ${count} 项，超出建议上限 ${max} 项，已压缩字号`);
}

/** Height of the bottom takeaway box for a given text width. */
function calloutHeight(callout, widthIn) {
  const labelH = callout?.label ? 0.22 : 0;
  const textH = textHeightIn(callout?.text ?? "", Math.max(2, widthIn - 0.5), 15, 1.32);
  return Math.max(0.72, Math.min(2.0, labelH + textH + 0.42));
}

/** Draw the takeaway box at the bottom edge of the content area. */
function pushCallout(shapes, callout, ctx, area) {
  const calloutH = calloutHeight(callout, area.w);
  const y = area.y + area.h - calloutH;
  shapes.push({
    t: "sp",
    name: "Callout",
    box: box(area.x, y, area.w, calloutH),
    geom: "roundRect",
    adj: 4000,
    fill: ctx.palette.surface,
    line: { color: tint(ctx.palette.primary, 0.72), width: 0.75 },
  });
  shapes.push({
    t: "sp",
    name: "Callout bar",
    box: box(area.x, y + 0.1, 0.05, calloutH - 0.2),
    fill: ctx.palette.primary,
  });
  const paras = [];
  if (callout.label) {
    paras.push(
      text(callout.label, {
        size: 12,
        bold: true,
        color: ctx.palette.chipText,
        font: ctx.fonts.body,
        spaceAfterPt: 3,
      }),
    );
  }
  paras.push(
    text(callout.text, {
      size: 15,
      color: ctx.palette.ink,
      font: ctx.fonts.body,
      lineSpacingPercent: 132,
    }),
  );
  shapes.push({
    t: "sp",
    name: "Callout text",
    box: box(area.x + 0.26, y + 0.1, area.w - 0.5, calloutH - 0.18),
    paras,
    anchor: "ctr",
    autofit: true,
  });
  return calloutH;
}

/* ------------------------------------------------------------- composers */

/** Cover: title block + accent rule + subtitle + meta, inside the safe area. */
export function composeCover(slide, ctx) {
  const raw = ctx.regions.area;
  const area = ctx.layout.hasArt
    ? raw
    : {
        x: raw.x,
        y: raw.y,
        w: Math.max(6, Math.min(raw.w, ctx.regions.slideW - 3.4 - raw.x - 0.8)),
        h: raw.h,
      };
  const title = slide.title;
  const subtitle = slide.subtitle ?? slide.lead ?? "";
  const meta = slide.meta ?? "";
  const wide = area.w;

  let titleSize = 44;
  for (let size = 44; size >= 28; size -= 2) {
    const lines = countLines(title, wide, size);
    if (lines <= 2) {
      titleSize = size;
      break;
    }
    titleSize = size;
  }
  const titleH = textHeightIn(title, wide, titleSize, 1.16);
  const subtitleH = subtitle ? textHeightIn(subtitle, wide, 20, 1.4) : 0;
  const metaH = meta ? 0.3 : 0;
  const blockH = titleH + 0.26 + 0.06 + 0.26 + subtitleH + (metaH ? 0.24 + metaH : 0);
  const top = area.y + Math.max(0, (area.h - blockH) / 2 - 0.18);

  const shapes = [];
  if (!ctx.layout.hasArt) {
    shapes.push({
      t: "sp",
      name: "Cover panel",
      box: box(ctx.regions.slideW - 3.4, 0, 3.4, ctx.regions.slideH),
      fill: ctx.palette.surface,
    });
    shapes.push({
      t: "sp",
      name: "Cover panel accent",
      box: box(ctx.regions.slideW - 3.4, 0, 0.12, ctx.regions.slideH),
      fill: ctx.palette.primary,
    });
  }

  let cursor = top;
  shapes.push({
    t: "sp",
    name: "Cover title",
    box: box(area.x, cursor, wide, titleH + 0.12),
    paras: [
      text(title, {
        size: titleSize,
        bold: true,
        color: ctx.palette.ink,
        font: ctx.fonts.title,
        lineSpacingPercent: 116,
      }),
    ],
    anchor: "t",
    autofit: false,
  });
  cursor += titleH + 0.26;
  shapes.push({
    t: "sp",
    name: "Cover rule",
    box: box(area.x, cursor, 1.5, 0.07),
    fill: ctx.palette.primary,
  });
  cursor += 0.06 + 0.28;
  if (subtitle) {
    shapes.push({
      t: "sp",
      name: "Cover subtitle",
      box: box(area.x, cursor, wide, subtitleH + 0.1),
      paras: [
        text(subtitle, {
          size: 20,
          color: ctx.palette.body,
          font: ctx.fonts.body,
          lineSpacingPercent: 138,
        }),
      ],
      anchor: "t",
      autofit: false,
    });
    cursor += subtitleH;
  }
  if (meta) {
    shapes.push({
      t: "sp",
      name: "Cover meta",
      box: box(area.x, cursor + 0.26, wide, 0.3),
      paras: [text(meta, { size: 13, color: ctx.palette.muted, font: ctx.fonts.body })],
      anchor: "t",
      autofit: false,
    });
  }
  return { shapes };
}

/** Section divider: index numeral, title, rule, optional subtitle. */
export function composeSection(slide, ctx) {
  const area = ctx.regions.area;
  const index = slide.index ?? null;
  const shapes = [];
  let cursor = area.y + Math.max(0, area.h / 2 - 1.5);

  if (index) {
    shapes.push({
      t: "sp",
      name: "Section index",
      box: box(area.x, cursor - 0.12, 1.9, 1.05),
      paras: [
        text(String(index).padStart(2, "0"), {
          size: 48,
          bold: true,
          color: tint(ctx.palette.primary, 0.55),
          font: ctx.fonts.title,
        }),
      ],
      anchor: "t",
      autofit: false,
    });
    cursor += 0.86;
  }

  const title = slide.title;
  let size = 40;
  for (; size >= 26; size -= 2) {
    if (countLines(title, area.w, size) <= 2) break;
  }
  const titleH = textHeightIn(title, area.w, Math.max(size, 26), 1.18);
  shapes.push({
    t: "sp",
    name: "Section title",
    box: box(area.x, cursor, area.w, titleH + 0.14),
    paras: [
      text(title, {
        size: Math.max(size, 26),
        bold: true,
        color: ctx.palette.ink,
        font: ctx.fonts.title,
        lineSpacingPercent: 118,
      }),
    ],
    anchor: "t",
    autofit: false,
  });
  cursor += titleH + 0.3;
  shapes.push({
    t: "sp",
    name: "Section rule",
    box: box(area.x, cursor, 1.5, 0.07),
    fill: ctx.palette.primary,
  });
  if (slide.subtitle) {
    shapes.push({
      t: "sp",
      name: "Section subtitle",
      box: box(area.x, cursor + 0.26, area.w, 0.6),
      paras: [text(slide.subtitle, { size: 18, color: ctx.palette.muted, font: ctx.fonts.body })],
      anchor: "t",
      autofit: false,
    });
  }
  // The divider draws its own headline, so no layout title placeholder is used.
  return { shapes, title: null };
}
/** Bullet slide: optional kicker/lead, statement rows with hairline dividers. */
export function composeBullets(slide, ctx) {
  const area = ctx.regions.area;
  const shapes = [];
  const bullets = slide.bullets ?? [];
  const callout = slide.callout ?? null;
  let top = area.y;

  if (slide.kicker) {
    shapes.push(...kickerShape(ctx, slide.kicker, box(area.x, area.y, 0, 0)));
    top += 0.46;
  }

  const lead = slide.lead ?? "";
  if (lead) {
    const size = 20;
    const h = textHeightIn(lead, area.w, size, 1.38);
    shapes.push({
      t: "sp",
      name: "Lead",
      box: box(area.x, top, area.w, h + 0.1),
      paras: [text(lead, { size, color: ctx.palette.ink, font: ctx.fonts.body, lineSpacingPercent: 138 })],
      anchor: "t",
      autofit: true,
    });
    top += h + 0.3;
  }

  const calloutH = callout ? calloutHeight(callout, area.w) : 0;
  const listBottom = area.y + area.h - (callout ? calloutH + 0.26 : 0);
  const available = Math.max(1, listBottom - top);

  if (bullets.length > 0) {
    countWarning(ctx, "要点", bullets.length, 6);
    const markerWidth = 0.28;
    const textWidth = area.w - markerWidth - 0.16;
    const divider = bullets.length >= 3 && bullets.length <= 5;
    const detailSize = 14;

    // Pick the largest size that still fits, so sparse slides fill the canvas
    // instead of clustering three lines in the top third.
    const budget = available * 0.94;
    let size = 26;
    for (; size >= 14; size -= 1) {
      let total = 0;
      for (const bullet of bullets) {
        const body = typeof bullet === "string" ? bullet : bullet.text;
        total += textHeightIn(body, textWidth, size, 1.36);
        if (bullet.detail) total += textHeightIn(bullet.detail, textWidth, detailSize, 1.3) + 0.06;
        total += 0.16;
      }
      if (total <= budget) break;
    }
    const rows = [];
    for (const bullet of bullets) {
      const body = typeof bullet === "string" ? bullet : bullet.text;
      const detail = typeof bullet === "string" ? "" : bullet.detail ?? "";
      const h =
        textHeightIn(body, textWidth, size, 1.36) +
        (detail ? textHeightIn(detail, textWidth, detailSize, 1.3) + 0.06 : 0);
      rows.push({ body, detail, h });
    }
    const stacked = rows.some((row) => row.detail) || rows.length > 4;
    const sumH = rows.reduce((sum, row) => sum + row.h, 0);
    const minGap = divider ? 0.18 : 0.14;
    // Sparse lists get one slot per row so the canvas is used edge to edge;
    // dense lists keep their natural height but spread the leftover space
    // between the rows instead of leaving a dead band at the bottom.
    const slot = stacked ? 0 : Math.min(2.0, available / rows.length);
    const gap = stacked
      ? Math.min(0.6, Math.max(minGap, ((available - sumH) / Math.max(1, rows.length - 1)) * 0.5))
      : minGap;
    const blockH = stacked ? sumH + gap * Math.max(0, rows.length - 1) : slot * rows.length;
    const rowTops = [];
    if (stacked) {
      let cursor = top + Math.max(0, (available - blockH) * 0.34);
      for (const row of rows) {
        rowTops.push(cursor);
        cursor += row.h + gap;
      }
    } else {
      const start = top + Math.max(0, (available - blockH) * 0.1);
      rows.forEach((_, index) => rowTops.push(start + index * slot));
    }
    rows.forEach((row, rowIndex) => {
      const rowTop = rowTops[rowIndex];
      const textTop = stacked ? rowTop : rowTop + Math.max(0, (slot - row.h) / 2);
      if (rowIndex > 0 && divider) {
        shapes.push({
          t: "sp",
          name: "Divider",
          box: box(area.x, rowTop - (stacked ? gap / 2 : 0.005), area.w, 0.01),
          fill: tint(ctx.palette.primary, 0.9),
        });
      }
      shapes.push({
        t: "sp",
        name: `Marker ${rowIndex + 1}`,
        box: box(area.x, textTop + size / 72 * 0.34, 0.14, 0.14),
        geom: "ellipse",
        fill: rowIndex === 0 ? ctx.palette.primary : tint(ctx.palette.primary, 0.55),
      });
      const paras = [
        text(row.body, {
          size,
          bold: rowIndex === 0 && bullets.length <= 4,
          color: ctx.palette.ink,
          font: ctx.fonts.body,
          lineSpacingPercent: 136,
        }),
      ];
      if (row.detail) {
        paras.push(
          text(row.detail, {
            size: detailSize,
            color: ctx.palette.muted,
            font: ctx.fonts.body,
            lineSpacingPercent: 130,
            spaceBeforePt: 4,
          }),
        );
      }
      shapes.push({
        t: "sp",
        name: `Bullet ${rowIndex + 1}`,
        box: box(area.x + markerWidth, textTop, textWidth + 0.12, row.h + 0.08),
        paras,
        anchor: "t",
        autofit: true,
      });
    });
  }

  if (callout) pushCallout(shapes, callout, ctx, area);

  return { shapes, title: titleShape(ctx, slide.title) };
}

/** KPI row: 2–4 cards, big numbers in the brand colour. */
export function composeMetrics(slide, ctx) {
  const area = ctx.regions.area;
  const metrics = slide.metrics ?? [];
  countWarning(ctx, "指标卡", metrics.length, 4);
  const shapes = [];
  let top = area.y;
  if (slide.lead) {
    const h = textHeightIn(slide.lead, area.w, 19, 1.36);
    shapes.push({
      t: "sp",
      name: "Lead",
      box: box(area.x, top, area.w, h + 0.1),
      paras: [text(slide.lead, { size: 19, color: ctx.palette.body, font: ctx.fonts.body, lineSpacingPercent: 136 })],
      anchor: "t",
      autofit: true,
    });
    top += h + 0.3;
  }
  const columns = Math.min(metrics.length, 4) || 1;
  const gap = 0.22;
  const cardW = (area.w - gap * (columns - 1)) / columns;
  const bottom = area.y + area.h - (slide.callout ? calloutHeight(slide.callout, area.w) + 0.24 : 0);
  const remaining = bottom - top;
  const cardH = Math.max(1.9, Math.min(remaining - 0.04, 3.6));
  const cardTop = top + Math.max(0, (remaining - cardH) * 0.22);
  const valueSize = columns <= 2 ? 46 : columns === 3 ? 38 : 32;
  const labelSize = columns <= 2 ? 16 : 15;

  metrics.slice(0, columns).forEach((metric, index) => {
    const x = area.x + index * (cardW + gap);
    shapes.push({
      t: "sp",
      name: `Metric card ${index + 1}`,
      box: box(x, cardTop, cardW, cardH),
      geom: "roundRect",
      adj: 5000,
      fill: ctx.palette.surface,
      line: { color: tint(ctx.palette.primary, 0.8), width: 0.75 },
    });
    shapes.push({
      t: "sp",
      name: `Metric accent ${index + 1}`,
      box: box(x, cardTop, cardW, 0.06),
      fill: index === 0 ? ctx.palette.primary : tint(ctx.palette.primary, 0.45),
    });
    const inner = insetBox({ x, y: cardTop, w: cardW, h: cardH }, 0.28, 0.3);
    const valueH = textHeightIn(metric.value, inner.w, valueSize, 1.1);
    const paras = [
      text(metric.value, {
        size: valueSize,
        bold: true,
        color: ctx.palette.primary,
        font: ctx.fonts.title,
        lineSpacingPercent: 110,
      }),
      text(metric.label, {
        size: labelSize,
        color: ctx.palette.ink,
        font: ctx.fonts.body,
        lineSpacingPercent: 130,
        spaceBeforePt: 8,
      }),
    ];
    if (metric.note) {
      paras.push(
        text(metric.note, {
          size: 12,
          color: ctx.palette.muted,
          font: ctx.fonts.body,
          lineSpacingPercent: 128,
          spaceBeforePt: 4,
        }),
      );
    }
    shapes.push({
      t: "sp",
      name: `Metric text ${index + 1}`,
      box: box(inner.x, cardTop + 0.16, inner.w, cardH - 0.3),
      paras,
      anchor: "ctr",
      autofit: true,
    });
    void valueH;
  });

  if (slide.callout) pushCallout(shapes, slide.callout, ctx, area);

  return { shapes, title: titleShape(ctx, slide.title), consumedLead: Boolean(slide.lead) };
}

/** Two/three columns, each with a heading and its own bullets. */
export function composeColumns(slide, ctx) {
  const area = ctx.regions.area;
  const columns = (slide.columns ?? []).slice(0, 3);
  countWarning(ctx, "分栏", (slide.columns ?? []).length, 3);
  const shapes = [];
  let top = area.y;
  if (slide.lead) {
    const h = textHeightIn(slide.lead, area.w, 19, 1.36);
    shapes.push({
      t: "sp",
      name: "Lead",
      box: box(area.x, top, area.w, h + 0.1),
      paras: [text(slide.lead, { size: 19, color: ctx.palette.body, font: ctx.fonts.body, lineSpacingPercent: 136 })],
      anchor: "t",
      autofit: true,
    });
    top += h + 0.28;
  }
  const count = columns.length || 1;
  const gap = 0.3;
  const colW = (area.w - gap * (count - 1)) / count;
  const bodyTop = top + 0.62;
  const bottom = area.y + area.h - (slide.callout ? calloutHeight(slide.callout, area.w) + 0.24 : 0);
  const bodyH = Math.max(1.2, bottom - bodyTop);
  const textWidthCol = colW - 0.26;

  // Normalise all columns first so every row shares one baseline grid.
  const plans = columns.map((column) => {
    const items = (column.bullets ?? []).map((item) =>
      typeof item === "string" ? { text: item } : item,
    );
    if (items.length === 0 && column.text) items.push({ text: column.text });
    return { column, items };
  });

  const maxItems = Math.max(1, ...plans.map((plan) => plan.items.length));
  const maxSize = maxItems <= 2 ? 22 : maxItems <= 4 ? 19 : 16;
  const size = Math.min(
    maxSize,
    ...plans.map((plan) =>
      fitSize(
        plan.items.map((item) => item.text),
        { widthIn: textWidthCol, heightIn: bodyH, max: maxSize, min: 11, lineFactor: 1.36, gapIn: 0.14 },
      ).size,
    ),
  );

  const rowHeights = Array.from({ length: maxItems }, (_, rowIndex) =>
    Math.max(
      0.3,
      ...plans.map((plan) =>
        plan.items[rowIndex] ? textHeightIn(plan.items[rowIndex].text, textWidthCol, size, 1.36) : 0,
      ),
    ),
  );
  const blockH = rowHeights.reduce((sum, value) => sum + value, 0);
  const itemGap =
    maxItems > 1
      ? Math.min(0.62, Math.max(0.18, (bodyH - blockH) / (maxItems * 1.5)))
      : 0;
  const offset = Math.min(0.5, Math.max(0, (bodyH - blockH) * 0.15));
  const rowTops = [];
  let cursor = bodyTop + offset;
  for (let rowIndex = 0; rowIndex < maxItems; rowIndex += 1) {
    rowTops.push(cursor);
    cursor += rowHeights[rowIndex] + itemGap;
  }

  plans.forEach((plan, index) => {
    const x = area.x + index * (colW + gap);
    shapes.push({
      t: "sp",
      name: `Column heading ${index + 1}`,
      box: box(x, top, colW, 0.42),
      paras: [
        text(plan.column.heading, {
          size: 17,
          bold: true,
          color: ctx.palette.ink,
          font: ctx.fonts.title,
        }),
      ],
      anchor: "b",
      autofit: false,
    });
    shapes.push({
      t: "sp",
      name: `Column rule ${index + 1}`,
      box: box(x, top + 0.48, Math.min(1.1, colW * 0.5), 0.05),
      fill: index === 0 ? ctx.palette.primary : tint(ctx.palette.primary, 0.5),
    });
    if (index > 0) {
      shapes.push({
        t: "sp",
        name: `Column divider ${index + 1}`,
        box: box(x - gap / 2, top - 0.04, 0.008, bodyH + 0.5),
        fill: tint(ctx.palette.primary, 0.88),
      });
    }

    plan.items.forEach((item, itemIndex) => {
      const y = rowTops[itemIndex];
      shapes.push({
        t: "sp",
        name: `Column dot ${index + 1}-${itemIndex + 1}`,
        box: box(x, y + size / 72 * 0.32, 0.1, 0.1),
        geom: "ellipse",
        fill: tint(ctx.palette.primary, 0.35),
      });
      shapes.push({
        t: "sp",
        name: `Column item ${index + 1}-${itemIndex + 1}`,
        box: box(x + 0.22, y, colW - 0.24, rowHeights[itemIndex] + 0.08),
        paras: [
          text(item.text, {
            size,
            color: ctx.palette.body,
            font: ctx.fonts.body,
            lineSpacingPercent: 136,
          }),
        ],
        anchor: "t",
        autofit: true,
      });
    });
  });

  if (slide.callout) pushCallout(shapes, slide.callout, ctx, area);

  return { shapes, title: titleShape(ctx, slide.title) };
}

/** Horizontal step flow with numbered nodes. */
export function composeSteps(slide, ctx) {
  const area = ctx.regions.area;
  const steps = (slide.steps ?? []).slice(0, 5);
  countWarning(ctx, "流程步骤", (slide.steps ?? []).length, 5);
  const shapes = [];
  let top = area.y;
  if (slide.lead) {
    const h = textHeightIn(slide.lead, area.w, 19, 1.36);
    shapes.push({
      t: "sp",
      name: "Lead",
      box: box(area.x, top, area.w, h + 0.1),
      paras: [text(slide.lead, { size: 19, color: ctx.palette.body, font: ctx.fonts.body, lineSpacingPercent: 136 })],
      anchor: "t",
      autofit: true,
    });
    top += h + 0.34;
  }
  const count = steps.length || 1;
  const gap = 0.22;
  const stepW = (area.w - gap * (count - 1)) / count;
  const flowHeight = 0.54 + 0.16 + 0.9 + (steps.some((step) => step.detail) ? 1.1 : 0);
  const bottom = area.y + area.h - (slide.callout ? calloutHeight(slide.callout, area.w) + 0.24 : 0);
  const nodeY = top + Math.max(0.1, (bottom - top - flowHeight) * 0.5);

  if (count > 1) {
    shapes.push({
      t: "sp",
      name: "Flow line",
      box: box(area.x + stepW / 2, nodeY + 0.24, area.w - stepW, 0.02),
      fill: tint(ctx.palette.primary, 0.76),
    });
  }

  steps.forEach((step, index) => {
    const x = area.x + index * (stepW + gap);
    shapes.push({
      t: "sp",
      name: `Step node ${index + 1}`,
      box: box(x + stepW / 2 - 0.27, nodeY, 0.54, 0.54),
      geom: "ellipse",
      fill: index === 0 ? ctx.palette.primary : ctx.palette.white,
      line: { color: index === 0 ? ctx.palette.primary : tint(ctx.palette.primary, 0.5), width: 1.25 },
    });
    shapes.push({
      t: "sp",
      name: `Step number ${index + 1}`,
      box: box(x + stepW / 2 - 0.27, nodeY + 0.02, 0.54, 0.5),
      paras: [
        text(String(index + 1), {
          size: 16,
          bold: true,
          color: index === 0 ? ctx.palette.onAccent : ctx.palette.primary,
          font: ctx.fonts.title,
          align: "ctr",
        }),
      ],
      anchor: "ctr",
      autofit: false,
    });
    const titleSize = fitSize([step.title], {
      widthIn: stepW,
      heightIn: 1.1,
      max: 16,
      min: 12,
      lineFactor: 1.3,
    }).size;
    shapes.push({
      t: "sp",
      name: `Step title ${index + 1}`,
      box: box(x, nodeY + 0.7, stepW, 0.8),
      paras: [
        text(step.title, {
          size: titleSize,
          bold: true,
          color: ctx.palette.ink,
          font: ctx.fonts.title,
          align: "ctr",
          lineSpacingPercent: 128,
        }),
      ],
      anchor: "t",
      autofit: true,
    });
    if (step.detail) {
      const detailH = Math.max(
        0.4,
        area.y + area.h - (nodeY + 1.5),
      );
      shapes.push({
        t: "sp",
        name: `Step detail ${index + 1}`,
        box: box(x, nodeY + 1.52, stepW, Math.min(detailH, 1.6)),
        paras: [
          text(step.detail, {
            size: 13,
            color: ctx.palette.muted,
            font: ctx.fonts.body,
            align: "ctr",
            lineSpacingPercent: 132,
          }),
        ],
        anchor: "t",
        autofit: true,
      });
    }
  });

  if (slide.callout) pushCallout(shapes, slide.callout, ctx, area);

  return { shapes, title: titleShape(ctx, slide.title) };
}

/** Data table with brand header and zebra rows. */
export function composeTable(slide, ctx) {
  const area = ctx.regions.area;
  const table = slide.table ?? { headers: [], rows: [] };
  const headers = table.headers ?? [];
  const rows = (table.rows ?? []).slice(0, 10);
  if ((table.rows ?? []).length > 10) ctx.warn(`表格 ${table.rows.length} 行，仅渲染前 10 行`);
  const shapes = [];
  let top = area.y;
  if (table.caption || slide.lead) {
    const caption = table.caption || slide.lead;
    const h = textHeightIn(caption, area.w, 14, 1.3);
    shapes.push({
      t: "sp",
      name: "Table caption",
      box: box(area.x, top, area.w, h + 0.06),
      paras: [text(caption, { size: 14, color: ctx.palette.muted, font: ctx.fonts.body })],
      anchor: "t",
      autofit: false,
    });
    top += h + 0.14;
  }
  const availableH = Math.max(
    1.0,
    area.y + area.h - top - (slide.callout ? calloutHeight(slide.callout, area.w) + 0.24 : 0),
  );
  const colCount = Math.max(headers.length, 1);
  const weights = headers.map((header, index) => {
    const widths = [header, ...rows.map((row) => row?.[index] ?? "")].map((value) =>
      textWidthEm(value),
    );
    return Math.max(4, Math.min(18, Math.max(...widths) + 2));
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  const cols = weights.map((weight) => (area.w * weight) / totalWeight);

  const headerSize = 13;
  const rowSize = 12.5;
  const headerH = Math.max(0.44, (headerSize * 1.5) / 72 + 0.18);
  const minRowH = Math.max(0.4, (rowSize * 1.6) / 72 + 0.16);
  // Grow rows to use the canvas, but stop before they look like empty strips.
  const rowH =
    rows.length > 0
      ? Math.min(0.88, Math.max(minRowH, (availableH - headerH) / rows.length))
      : minRowH;
  const totalH = headerH + rowH * rows.length;
  const tableTop = top + Math.max(0, (availableH - totalH) * 0.2);

  const headerCells = headers.map((header, index) => ({
    paras: [
      text(header, {
        size: headerSize,
        bold: true,
        color: ctx.palette.onAccent,
        font: ctx.fonts.body,
        align: index === 0 ? "l" : "ctr",
      }),
    ],
    fill: ctx.palette.primary,
  }));
  while (headerCells.length < colCount) {
    headerCells.push({ paras: [], fill: ctx.palette.primary });
  }

  const bodyRows = rows.map((row, rowIndex) => ({
    h: rowH,
    cells: Array.from({ length: colCount }, (_, colIndex) => ({
      paras: [
        text(row?.[colIndex] ?? "", {
          size: rowSize,
          color: ctx.palette.ink,
          font: ctx.fonts.body,
          align: colIndex === 0 ? "l" : "ctr",
          bold: colIndex === 0,
        }),
      ],
      fill: rowIndex % 2 === 1 ? tint(ctx.palette.primary, 0.96) : ctx.palette.white,
      borderBottom: { color: tint(ctx.palette.primary, 0.85), width: 0.5 },
    })),
  }));

  shapes.push({
    t: "table",
    name: "Data table",
    box: box(area.x, tableTop, area.w, Math.min(totalH, availableH)),
    cols,
    rows: [{ h: headerH, cells: headerCells }, ...bodyRows],
  });

  if (slide.callout) pushCallout(shapes, slide.callout, ctx, area);

  return { shapes, title: titleShape(ctx, slide.title) };
}

/**
 * Charts drawn as native shapes (no embedded chart part, so no workbook
 * dependency): `column` draws vertical bars, `bar` draws horizontal bars, and
 * `pie` draws a 100% stacked bar plus a legend — the proportions stay readable
 * without shipping an Excel object that PowerPoint may redraw differently.
 */
export function composeChart(slide, ctx) {
  const area = ctx.regions.area;
  const shapes = [];
  const chart = slide.chart ?? {};
  const kind = chart.kind === "column" || chart.kind === "pie" ? chart.kind : "bar";
  const rows = (chart.rows ?? []).filter((row) => row && row.label !== undefined);
  if (rows.length === 0) return { shapes, title: titleShape(ctx, slide.title) };

  countWarning(ctx, "图表数据", rows.length, 8);
  const colors = [
    ctx.palette.primary,
    ctx.palette.accent,
    shade(ctx.palette.primary, 0.3),
    tint(ctx.palette.primary, 0.55),
    shade(ctx.palette.accent, 0.32),
    tint(ctx.palette.accent, 0.52),
    shade(ctx.palette.primary, 0.5),
    tint(ctx.palette.accent, 0.7),
  ];
  const values = rows.map((row) => Number(row.value) || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const label = (value) => (chart.unit ? `${value}${chart.unit}` : `${value}`);
  const top = area.y + 0.1;

  if (kind === "pie") {
    const barH = 0.62;
    const legendRows = Math.ceil(rows.length / 2);
    const legendRowH = Math.min(
      0.72,
      Math.max(0.42, (area.h - barH - 0.5) / Math.max(1, legendRows)),
    );
    const blockH = barH + 0.34 + legendRows * legendRowH;
    const barY = area.y + Math.max(0.1, (area.h - blockH) * 0.32);
    const barW = area.w;
    const safeTotal = total > 0 ? total : rows.length;
    let cursor = area.x;
    rows.forEach((row, index) => {
      const share = ((Number(row.value) || 0) / safeTotal) * barW;
      shapes.push({
        t: "sp",
        name: `Chart slice ${index + 1}`,
        box: box(cursor, barY, Math.max(0.02, share), barH),
        fill: colors[index % colors.length],
      });
      if (share > 0.9) {
        shapes.push({
          t: "sp",
          name: `Chart slice label ${index + 1}`,
          box: box(cursor, barY, share, barH),
          paras: [
            text(`${Math.round(((Number(row.value) || 0) / safeTotal) * 100)}%`, {
              size: 13,
              bold: true,
              align: "ctr",
              color: "FFFFFF",
              font: ctx.fonts.body,
            }),
          ],
          anchor: "ctr",
          autofit: false,
        });
      }
      cursor += share;
    });

    const legendTop = barY + barH + 0.34;
    const columnW = area.w / 2 - 0.2;
    const rowH = legendRowH;
    rows.forEach((row, index) => {
      const column = index % 2;
      const line = Math.floor(index / 2);
      const x = area.x + column * (columnW + 0.4);
      const y = legendTop + line * rowH;
      shapes.push({
        t: "sp",
        name: `Chart legend dot ${index + 1}`,
        box: box(x, y + 0.1, 0.13, 0.13),
        fill: colors[index % colors.length],
      });
      shapes.push({
        t: "sp",
        name: `Chart legend ${index + 1}`,
        box: box(x + 0.24, y - 0.02, columnW - 0.3, rowH - 0.04),
        paras: [
          text(`${row.label}  ${label(row.value)}`, {
            size: 13,
            color: ctx.palette.body,
            font: ctx.fonts.body,
            lineSpacingPercent: 126,
          }),
        ],
        anchor: "ctr",
        autofit: false,
      });
    });
    return { shapes, title: titleShape(ctx, slide.title) };
  }

  if (kind === "column") {
    const max = Math.max(...values, 1);
    const labelH = 0.5;
    const valueH = 0.3;
    const plotTop = top + 0.24;
    const plotBottom = area.y + area.h - labelH - valueH;
    const plotH = Math.max(0.8, plotBottom - plotTop);
    const slot = area.w / rows.length;
    const barW = Math.min(1.5, slot * 0.52);

    rows.forEach((row, index) => {
      const value = Number(row.value) || 0;
      const h = Math.max(0.05, (value / max) * plotH);
      const x = area.x + slot * index + (slot - barW) / 2;
      const y = plotBottom - h;
      shapes.push({
        t: "sp",
        name: `Chart bar ${index + 1}`,
        box: box(x, y, barW, h),
        geom: "roundRect",
        adj: 8000,
        fill: colors[index % colors.length],
      });
      shapes.push({
        t: "sp",
        name: `Chart value ${index + 1}`,
        box: box(x - 0.15, y - valueH - 0.04, barW + 0.3, valueH),
        paras: [
          text(label(value), {
            size: 14,
            bold: true,
            align: "ctr",
            color: ctx.palette.ink,
            font: ctx.fonts.body,
          }),
        ],
        anchor: "b",
        autofit: false,
      });
      shapes.push({
        t: "sp",
        name: `Chart axis label ${index + 1}`,
        box: box(area.x + slot * index + 0.06, plotBottom + 0.1, slot - 0.12, labelH),
        paras: [
          text(row.label, {
            size: 13,
            align: "ctr",
            color: ctx.palette.body,
            font: ctx.fonts.body,
            lineSpacingPercent: 120,
          }),
        ],
        anchor: "t",
        autofit: false,
      });
    });

    shapes.push({
      t: "sp",
      name: "Chart baseline",
      box: box(area.x, plotBottom, area.w, 0.02),
      fill: ctx.palette.rule,
    });
    return { shapes, title: titleShape(ctx, slide.title) };
  }

  // Horizontal bars: label on the left, bar to the right, value after the bar.
  const max = Math.max(...values, 1);
  const valueW = 1.15;
  const labelW = Math.min(3.4, Math.max(1.9, area.w * 0.26));
  const trackX = area.x + labelW + 0.2;
  const trackW = Math.max(1.2, area.w - labelW - valueW - 0.4);
  const slot = Math.min(1.0, (area.h - 0.2) / rows.length);
  const barH = Math.min(0.5, slot * 0.52);
  const startY = area.y + Math.max(0, (area.h - slot * rows.length) * 0.34);

  rows.forEach((row, index) => {
    const value = Number(row.value) || 0;
    const y = startY + index * slot + (slot - barH) / 2;
    shapes.push({
      t: "sp",
      name: `Chart label ${index + 1}`,
      box: box(area.x, y - 0.06, labelW, barH + 0.12),
      paras: [
        text(row.label, {
          size: 14,
          color: ctx.palette.ink,
          font: ctx.fonts.body,
          lineSpacingPercent: 120,
        }),
      ],
      anchor: "ctr",
      autofit: false,
    });
    shapes.push({
      t: "sp",
      name: `Chart track ${index + 1}`,
      box: box(trackX, y, trackW, barH),
      geom: "roundRect",
      adj: 12000,
      fill: ctx.palette.surfaceAlt,
    });
    shapes.push({
      t: "sp",
      name: `Chart bar ${index + 1}`,
      box: box(trackX, y, Math.max(0.04, (value / max) * trackW), barH),
      geom: "roundRect",
      adj: 12000,
      fill: colors[index % colors.length],
    });
    shapes.push({
      t: "sp",
      name: `Chart value ${index + 1}`,
      box: box(trackX + trackW + 0.12, y - 0.04, valueW, barH + 0.08),
      paras: [
        text(label(value), {
          size: 14,
          bold: true,
          color: ctx.palette.ink,
          font: ctx.fonts.body,
        }),
      ],
      anchor: "ctr",
      autofit: false,
    });
  });

  return { shapes, title: titleShape(ctx, slide.title) };
}

/** Pull quote with an oversized mark. */
export function composeQuote(slide, ctx) {
  const area = ctx.regions.area;
  const quote = slide.quote ?? { text: "" };
  const shapes = [];
  const textWidth = Math.min(area.w, 9.6);
  const quoteSize = fitSize([quote.text], {
    widthIn: textWidth,
    heightIn: area.h - 1.5,
    max: 30,
    min: 18,
    lineFactor: 1.44,
  }).size;
  const quoteH = textHeightIn(quote.text, textWidth, quoteSize, 1.44);
  const blockH = 0.7 + quoteH + (quote.source ? 0.5 : 0);
  const top = area.y + Math.max(0, (area.h - blockH) / 2);

  shapes.push({
    t: "sp",
    name: "Quote mark",
    box: box(area.x, top - 0.16, 1.15, 1.15),
    paras: [
      text("“", {
        size: 64,
        bold: true,
        color: tint(ctx.palette.primary, 0.6),
        font: ctx.fonts.title,
        lineSpacingPercent: 100,
      }),
    ],
    anchor: "t",
    autofit: false,
  });
  shapes.push({
    t: "sp",
    name: "Quote text",
    box: box(area.x + 1.05, top + 0.12, textWidth, quoteH + 0.2),
    paras: [
      text(quote.text, {
        size: quoteSize,
        color: ctx.palette.ink,
        font: ctx.fonts.body,
        lineSpacingPercent: 144,
      }),
    ],
    anchor: "t",
    autofit: true,
  });
  if (quote.source) {
    shapes.push({
      t: "sp",
      name: "Quote source",
      box: box(area.x + 1.05, top + quoteH + 0.26, textWidth, 0.34),
      paras: [
        text(`— ${quote.source}`, {
          size: 14,
          color: ctx.palette.muted,
          font: ctx.fonts.body,
        }),
      ],
      anchor: "t",
      autofit: false,
    });
  }
  return { shapes, title: slide.title ? titleShape(ctx, slide.title) : null };
}

/** Agenda: numbered contents page. */
export function composeAgenda(slide, ctx) {
  const area = ctx.regions.area;
  const items = (slide.items ?? slide.bullets ?? []).map((item) =>
    typeof item === "string" ? { title: item } : item,
  );
  countWarning(ctx, "目录条目", items.length, 8);
  const shapes = [];
  const twoColumn = items.length > 4;
  const colCount = twoColumn ? 2 : 1;
  const gap = 0.4;
  const colW = (area.w - gap * (colCount - 1)) / colCount;
  const perColumn = Math.ceil(items.length / colCount);
  const rowH = Math.min(2.0, area.h / Math.max(perColumn, 1));
  const blockH = rowH * perColumn;
  const originY = area.y + Math.max(0, (area.h - blockH) / 2) * 0.6;

  items.forEach((item, index) => {
    const col = Math.floor(index / perColumn);
    const row = index % perColumn;
    const x = area.x + col * (colW + gap);
    const y = originY + row * rowH;
    shapes.push({
      t: "sp",
      name: `Agenda number ${index + 1}`,
      box: box(x, y, 0.62, rowH - 0.1),
      paras: [
        text(String(index + 1).padStart(2, "0"), {
          size: 26,
          bold: true,
          color: tint(ctx.palette.primary, 0.45),
          font: ctx.fonts.title,
        }),
      ],
      anchor: "ctr",
      autofit: false,
    });
    shapes.push({
      t: "sp",
      name: `Agenda item ${index + 1}`,
      box: box(x + 0.74, y, colW - 0.8, rowH - 0.1),
      paras: [
        text(item.title, {
          size: 20,
          color: ctx.palette.ink,
          font: ctx.fonts.body,
        }),
      ],
      anchor: "ctr",
      autofit: false,
    });
    if (index < items.length - 1 && (row < perColumn - 1 || col < colCount - 1)) {
      shapes.push({
        t: "sp",
        name: `Agenda divider ${index + 1}`,
        box: box(x, y + rowH - 0.06, colW, 0.008),
        fill: tint(ctx.palette.primary, 0.88),
      });
    }
  });

  return { shapes, title: titleShape(ctx, slide.title) };
}

/** Closing slide. */
export function composeClosing(slide, ctx) {
  const area = ctx.regions.area;
  const shapes = [];
  const title = slide.title || "谢谢";
  const subtitle = slide.subtitle ?? "";
  const size = 46;
  const titleH = textHeightIn(title, area.w, size, 1.16);
  const top = area.y + Math.max(0, (area.h - (titleH + 1.0)) / 2);
  shapes.push({
    t: "sp",
    name: "Closing title",
    box: box(area.x, top, area.w, titleH + 0.16),
    paras: [
      text(title, {
        size,
        bold: true,
        color: ctx.palette.ink,
        font: ctx.fonts.title,
        lineSpacingPercent: 116,
      }),
    ],
    anchor: "t",
    autofit: false,
  });
  shapes.push({
    t: "sp",
    name: "Closing rule",
    box: box(area.x, top + titleH + 0.24, 1.5, 0.07),
    fill: ctx.palette.primary,
  });
  if (subtitle) {
    shapes.push({
      t: "sp",
      name: "Closing subtitle",
      box: box(area.x, top + titleH + 0.52, area.w, 0.9),
      paras: [
        text(subtitle, {
          size: 18,
          color: ctx.palette.muted,
          font: ctx.fonts.body,
          lineSpacingPercent: 140,
        }),
      ],
      anchor: "t",
      autofit: true,
    });
  }
  return { shapes };
}
