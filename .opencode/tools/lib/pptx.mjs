import {
  appPropsXml,
  contentTypesXml,
  corePropsXml,
  fail,
  optionalString,
  relationshipsXml,
  requireArray,
  requireString,
  xmlEscape,
} from "./shared.mjs";
import { themeXml } from "./theme.mjs";
import { createZip } from "./zip.mjs";
import {
  buildFonts,
  buildPalette,
  composeAgenda,
  composeBullets,
  composeChart,
  composeClosing,
  composeColumns,
  composeCover,
  composeMetrics,
  composeQuote,
  composeSection,
  composeSteps,
  composeTable,
  renderShapes,
  text,
} from "./deck.mjs";

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU = 914400;
const SLIDE_W = 12192000;
const SLIDE_H = 6858000;
const toInches = (value) => Number(value) / EMU;

/** Slide kinds the composer understands, and the layout role each one needs. */
const KINDS = new Set([
  "cover",
  "agenda",
  "section",
  "bullets",
  "metrics",
  "columns",
  "steps",
  "table",
  "chart",
  "quote",
  "closing",
]);
const LAYOUT_ROLE = {
  cover: "cover",
  agenda: "content",
  section: "section",
  closing: "section",
  bullets: "content",
  content: "content",
  metrics: "content",
  columns: "content",
  steps: "content",
  table: "content",
  chart: "content",
  quote: "content",
};

/* ------------------------------------------------------------- xml helpers */

function decodeXmlValue(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return String(value ?? "").replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (match, entity) => {
      const key = entity.toLowerCase();
      if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      return entities[key] ?? match;
    },
  );
}

function xmlAttr(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`\\b${escaped}="([^"]*)"`, "i"));
  return match ? decodeXmlValue(match[1]) : "";
}

function parseRelationships(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<Relationship\b[^>]*\/>/g)].map((match) => ({
    id: xmlAttr(match[0], "Id"),
    type: xmlAttr(match[0], "Type"),
    target: xmlAttr(match[0], "Target"),
  }));
}

function xmlBlock(xml, tag) {
  return xml.match(new RegExp(`<p:${tag}\\b[\\s\\S]*?<\\/p:${tag}>`))?.[0] ?? "";
}

function geometryOf(fragment) {
  const off = fragment.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
  const ext = fragment.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  if (!off || !ext) return null;
  return {
    x: toInches(off[1]),
    y: toInches(off[2]),
    w: toInches(ext[1]),
    h: toInches(ext[2]),
  };
}

/* ----------------------------------------------------------- layout parsing */

function placeholderAttrs(tag) {
  const type = xmlAttr(tag, "type");
  const idx = xmlAttr(tag, "idx");
  const parts = [];
  if (type) parts.push(`type="${type}"`);
  if (idx) parts.push(`idx="${idx}"`);
  return parts.join(" ");
}

function parseLayout(part, xml, master) {
  const cSldTag = xml.match(/<p:cSld\b[^>]*>/)?.[0] ?? "";
  const rootTag = xml.match(/<p:sldLayout\b[^>]*>/)?.[0] ?? "";
  const placeholders = [];
  const obstacles = [];

  for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const block = match[0];
    const phTag = block.match(/<p:ph\b[^>]*\/?>/)?.[0];
    const geometry = geometryOf(block);
    if (phTag) {
      placeholders.push({
        attrs: placeholderAttrs(phTag),
        type: xmlAttr(phTag, "type"),
        idx: xmlAttr(phTag, "idx"),
        box: geometry,
        isTextBox: /txBox="1"/.test(block),
        hasSlideNumber: /<a:fld[^>]*type="slidenum"/i.test(block),
      });
    } else if (geometry) {
      obstacles.push(geometry);
    }
  }

  for (const match of xml.matchAll(/<p:pic>[\s\S]*?<\/p:pic>/g)) {
    const geometry = geometryOf(match[0]);
    if (geometry) obstacles.push(geometry);
  }

  const resolve = (placeholder, fallback) => {
    if (!placeholder) return null;
    if (placeholder.box) return placeholder.box;
    return fallback ?? null;
  };

  const titlePh = placeholders.find((item) => /^(title|ctrTitle)$/.test(item.type ?? ""));
  const bodyPh =
    placeholders.find((item) => /^(body|subTitle|obj)$/.test(item.type ?? "")) ||
    placeholders.find((item) => !item.type && item.idx) ||
    null;
  const slideNumberBox = placeholders.find((item) => item.hasSlideNumber && item.isTextBox);

  const titleBox = resolve(titlePh, master?.title);
  const bodyBox = resolve(bodyPh, master?.body);

  return {
    index: Number(part.match(/slideLayout(\d+)\.xml$/)?.[1] ?? 0),
    part,
    name: xmlAttr(cSldTag, "name") || `slideLayout${part.match(/slideLayout(\d+)/)?.[1] ?? ""}`,
    type: xmlAttr(rootTag, "type") || null,
    titlePh: titlePh ? titlePh.attrs : "",
    bodyPh: bodyPh ? bodyPh.attrs : "",
    titleBox,
    bodyBox,
    obstacles,
    hasSlideNumber: placeholders.some((item) => item.hasSlideNumber),
    hasSlideNumberBox: Boolean(slideNumberBox),
    hasArt: obstacles.length > 0,
    hasTitle: Boolean(titlePh),
    hasBody: Boolean(bodyPh),
  };
}

function parseMasterGeometry(xml) {
  const pick = (pattern) => {
    for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      const block = match[0];
      const phTag = block.match(/<p:ph\b[^>]*\/?>/)?.[0];
      if (!phTag || !pattern.test(xmlAttr(phTag, "type"))) continue;
      const geometry = geometryOf(block);
      if (geometry) return geometry;
    }
    return null;
  };
  return { title: pick(/^(title|ctrTitle)$/), body: pick(/^(body|obj)$/) };
}

function contentArea(layout, slideW, slideH) {
  if (layout.bodyBox) return { ...layout.bodyBox };
  const side = 0.75;
  const titleBottom = layout.titleBox ? layout.titleBox.y + layout.titleBox.h : 1.0;
  const top = titleBottom + (layout.titleBox ? 0.3 : 0.28);
  // Keep the body clear of the footer band and of the corner decoration that
  // the design layouts carry along the bottom edge.
  const bottom = 1.0;
  return {
    x: side,
    y: top,
    w: slideW - side * 2,
    h: Math.max(1.5, slideH - top - bottom),
  };
}

/** Shrink the title band so it never runs under a logo/decor at the top right. */
function titleBoxFor(layout, area) {
  const base = layout.titleBox ?? {
    x: area.x,
    y: Math.max(0.16, area.y - 1.0),
    w: area.w,
    h: 0.8,
  };
  let right = base.x + base.w;
  const band = { y: base.y, h: base.h + 0.1 };
  for (const obstacle of layout.obstacles) {
    const overlapsY = obstacle.y < band.y + band.h && obstacle.y + obstacle.h > band.y;
    const startsAfter = obstacle.x > base.x + 1.0;
    if (overlapsY && startsAfter && obstacle.x < right) right = obstacle.x - 0.16;
  }
  return { ...base, x: Math.max(base.x, area.x), w: Math.max(2.4, right - Math.max(base.x, area.x)) };
}

function chooseLayout(layouts, layoutMap, role) {
  const mapped = layoutMap?.[role];
  if (mapped !== undefined && mapped !== null && mapped !== "") {
    const found = layouts.find(
      (layout) =>
        layout.name === String(mapped) ||
        layout.part === String(mapped) ||
        String(layout.index) === String(mapped),
    );
    if (found) return found;
  }
  const byName = (pattern) => layouts.find((layout) => pattern.test(layout.name));
  const byType = (type) => layouts.find((layout) => layout.type === type);
  if (role === "cover") {
    return (
      byName(/封面|cover/i) ||
      byType("title") ||
      layouts.find((layout) => layout.hasTitle && layout.hasArt) ||
      layouts.find((layout) => layout.hasTitle) ||
      layouts[0]
    );
  }
  if (role === "section") {
    return (
      byType("secHead") ||
      byName(/节|section/i) ||
      byName(/内容|content/i) ||
      layouts.find((layout) => layout.hasTitle && layout.hasBody) ||
      chooseLayout(layouts, layoutMap, "content")
    );
  }
  return (
    layouts.find((layout) => layout.hasTitle && layout.hasBody && layout.hasArt) ||
    byName(/内容|content/i) ||
    layouts.find((layout) => layout.hasTitle && layout.hasBody) ||
    byType("obj") ||
    layouts.find((layout) => layout.hasBody) ||
    layouts[0]
  );
}

/* --------------------------------------------------------------- composers */

const COMPOSERS = {
  cover: composeCover,
  agenda: composeAgenda,
  section: composeSection,
  bullets: composeBullets,
  metrics: composeMetrics,
  columns: composeColumns,
  steps: composeSteps,
  table: composeTable,
  chart: composeChart,
  quote: composeQuote,
  closing: composeClosing,
};

function normalizeSlide(slide, index) {
  if (!slide || typeof slide !== "object") {
    fail("INVALID_SLIDE", `slides[${index}] must be an object.`, { index });
  }
  const requested = slide.layout === undefined ? "" : String(slide.layout).toLowerCase();
  if (requested && !KINDS.has(requested) && requested !== "content") {
    fail(
      "INVALID_SLIDE",
      `slides[${index}].layout must be one of ${[...KINDS].join(", ")}.`,
      { index, layout: requested },
    );
  }
  let kind = requested === "content" ? "" : requested;
  if (!kind) {
    if (slide.quote) kind = "quote";
    else if (slide.table) kind = "table";
    else if (slide.chart) kind = "chart";
    else if (slide.metrics) kind = "metrics";
    else if (slide.steps) kind = "steps";
    else if (slide.columns) kind = "columns";
    else kind = "bullets";
  }
  if (kind === "chart") {
    const title = requireString(slide.title, `slides[${index}].title`, { max: 200 });
    const chart = slide.chart && typeof slide.chart === "object" ? slide.chart : {};
    const chartKind = ["column", "bar", "pie"].includes(String(chart.kind))
      ? String(chart.kind)
      : "bar";
    const rows = requireArray(chart.rows, `slides[${index}].chart.rows`, { min: 1, max: 12 }).map(
      (row, rowIndex) => {
        if (!row || typeof row !== "object") {
          fail("INVALID_SLIDE", `slides[${index}].chart.rows[${rowIndex}] must be an object.`, {
            index,
            row: rowIndex,
          });
        }
        const label = requireString(
          row.label,
          `slides[${index}].chart.rows[${rowIndex}].label`,
          { max: 60 },
        );
        const value = Number(row.value);
        if (!Number.isFinite(value)) {
          fail(
            "INVALID_SLIDE",
            `slides[${index}].chart.rows[${rowIndex}].value must be a number.`,
            { index, row: rowIndex },
          );
        }
        return { label, value };
      },
    );
    const unit = optionalString(chart.unit, `slides[${index}].chart.unit`, { max: 8 });
    return { ...slide, kind, title, chart: { kind: chartKind, rows, unit } };
  }
  if (kind === "bullets") {
    const title = requireString(slide.title, `slides[${index}].title`, { max: 200 });
    const bullets = slide.bullets === undefined
      ? []
      : requireArray(slide.bullets, `slides[${index}].bullets`, { min: 0, max: 8 }).map(
          (bullet, bulletIndex) => {
            if (typeof bullet === "string") {
              return requireString(bullet, `slides[${index}].bullets[${bulletIndex}]`, {
                max: 500,
              });
            }
            if (bullet && typeof bullet === "object") {
              return {
                text: requireString(bullet.text, `slides[${index}].bullets[${bulletIndex}].text`, {
                  max: 500,
                }),
                detail: optionalString(
                  bullet.detail,
                  `slides[${index}].bullets[${bulletIndex}].detail`,
                  { max: 300 },
                ),
              };
            }
            return requireString(String(bullet ?? ""), `slides[${index}].bullets[${bulletIndex}]`, {
              max: 500,
            });
          },
        );
    return { ...slide, kind, title, bullets };
  }
  const title =
    slide.title === undefined || slide.title === ""
      ? kind === "closing"
        ? "谢谢"
        : ""
      : requireString(slide.title, `slides[${index}].title`, { max: 200 });
  if (!title && kind !== "quote") {
    fail("INVALID_SLIDE", `slides[${index}].title is required for a ${kind} slide.`, {
      index,
      layout: kind,
    });
  }
  return { ...slide, kind, title };
}

function buildSlideBody({ slide, role, layout, palette, fonts, number, total, slideW, slideH, warnings }) {
  const area = contentArea(layout, slideW, slideH);
  const ctx = {
    palette,
    fonts,
    layout,
    regions: {
      area,
      title: titleBoxFor(layout, area),
      slideW,
      slideH,
      number,
      total,
    },
    warn: (message) => warnings.push({ slide: number, message }),
  };

  const kind = role === "cover" ? "cover" : slide.kind;
  const compose = COMPOSERS[kind] ?? composeBullets;

  let payload;
  try {
    payload = compose(
      { ...slide, index: slide.index ?? number - 1, layout },
      ctx,
    );
  } catch (error) {
    fail("SLIDE_BUILD_ERROR", `Cannot build slide ${number}.`, {
      slide: number,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const shapes = [...(payload.title ?? []), ...payload.shapes];
  if (role !== "cover" && !layout.hasSlideNumberBox) {
    shapes.push({
      t: "sp",
      name: "Slide number",
      box: { x: slideW - 1.45, y: slideH - 0.52, w: 0.9, h: 0.28 },
      paras: [
        text(`${number} / ${total}`, {
          size: 10,
          color: palette.muted,
          font: fonts.body,
          align: "r",
        }),
      ],
      anchor: "ctr",
      autofit: false,
    });
  }

  return { shapes, ctx };
}

/* ------------------------------------------------------------- slide xml */

function slideXml(shapesXml, { background = true } = {}) {
  const bg = background
    ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  <p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapesXml}</p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

/* -------------------------------------------------- master-backed package */

function isRemovedMasterPart(part) {
  const name = String(part ?? "").replace(/^\/+/, "");
  return (
    name.startsWith("ppt/slides/") ||
    name.startsWith("ppt/notesSlides/") ||
    name.startsWith("ppt/comments/") ||
    name === "ppt/commentAuthors.xml" ||
    name.startsWith("docProps/thumbnail.") ||
    name === "docProps/custom.xml"
  );
}

function updateMasterContentTypes(xml, slideCount, template) {
  const defaults = [...xml.matchAll(/<Default\b[^>]*\/>/g)].map((match) => match[0]);
  const overrides = new Map();
  for (const match of xml.matchAll(/<Override\b[^>]*\/>/g)) {
    const part = xmlAttr(match[0], "PartName");
    const contentType = xmlAttr(match[0], "ContentType");
    if (!part || !contentType || isRemovedMasterPart(part)) continue;
    if (
      part === "/ppt/presentation.xml" ||
      part === "/docProps/core.xml" ||
      part === "/docProps/app.xml"
    ) {
      continue;
    }
    overrides.set(part, contentType);
  }
  overrides.set(
    "/ppt/presentation.xml",
    template
      ? "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  );
  overrides.set(
    "/docProps/core.xml",
    "application/vnd.openxmlformats-package.core-properties+xml",
  );
  overrides.set(
    "/docProps/app.xml",
    "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  );
  for (let index = 1; index <= slideCount; index += 1) {
    overrides.set(
      `/ppt/slides/slide${index}.xml`,
      "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
    );
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaults.join("")}
  ${[...overrides]
    .map(
      ([part, contentType]) =>
        `<Override PartName="${xmlEscape(part)}" ContentType="${xmlEscape(contentType)}"/>`,
    )
    .join("")}
</Types>`;
}

function buildPptxFromMaster(spec, { template = false, themeXml: theme, masterPackage }) {
  if (!spec || typeof spec !== "object") {
    fail("INVALID_INPUT", "Expected a PPTX specification object.");
  }
  if (!masterPackage?.entries?.length) {
    fail("MASTER_PACKAGE_INVALID", "Master package entries are missing.", {
      master: masterPackage?.id,
    });
  }

  const title = requireString(spec.title, "title", { max: 200 });
  const author = optionalString(spec.author, "author", { max: 120 }) || "PM-Agent";
  const slides = requireArray(spec.slides, "slides", { min: 1, max: 40 });
  const warnings = [];

  const entryMap = new Map(masterPackage.entries.map((entry) => [entry.name, entry]));
  const getXml = (name) => entryMap.get(name)?.data.toString("utf8") ?? "";
  const presentationPart = getXml("ppt/presentation.xml");
  const presentationRels = getXml("ppt/_rels/presentation.xml.rels");
  const contentTypes = getXml("[Content_Types].xml");
  if (!presentationPart || !presentationRels || !contentTypes) {
    fail("MASTER_PACKAGE_INVALID", "Master package is missing presentation parts.", {
      master: masterPackage.id,
      path: masterPackage.path,
    });
  }

  const masterRel = parseRelationships(presentationRels).find((rel) =>
    rel.type.endsWith("/slideMaster"),
  );
  const masterPart = masterRel
    ? `ppt/${masterRel.target.replace(/^\.\.\//, "").replace(/^slides\//, "")}`
    : "ppt/slideMasters/slideMaster1.xml";
  const masterXml = getXml(masterPart);
  const masterGeometry = parseMasterGeometry(masterXml);

  const layouts = [...entryMap.keys()]
    .filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))
    .map((name) => parseLayout(name, getXml(name), masterGeometry))
    .sort((a, b) => a.index - b.index);
  if (!layouts.length) {
    fail("MASTER_PACKAGE_INVALID", "Master package has no slide layouts.", {
      master: masterPackage.id,
      path: masterPackage.path,
    });
  }

  const brand = masterPackage.metadata?.theme ?? null;
  const palette = buildPalette({ themeXml: theme, brand });
  const fonts = buildFonts({ themeXml: theme, brand });

  const layoutByRole = {
    cover: chooseLayout(layouts, masterPackage.layoutMap, "cover"),
    content: chooseLayout(layouts, masterPackage.layoutMap, "content"),
    section: chooseLayout(layouts, masterPackage.layoutMap, "section"),
  };

  const normalized = slides.map(normalizeSlide);
  const totalSlides = normalized.length + 1;
  const coverSlide = {
    kind: "cover",
    title,
    subtitle: optionalString(spec.subtitle, "subtitle", { max: 500 }),
    meta: optionalString(spec.meta, "meta", { max: 200 }),
  };
  const built = [coverSlide, ...normalized].map((slide, index) => {
    const role = index === 0 ? "cover" : LAYOUT_ROLE[slide.kind] ?? "content";
    const layout = layoutByRole[role] ?? layoutByRole.content;
    const { shapes, ctx } = buildSlideBody({
      slide,
      role,
      layout,
      palette,
      fonts,
      number: index + 1,
      total: totalSlides,
      slideW: toInches(SLIDE_W),
      slideH: toInches(SLIDE_H),
      warnings,
    });
    const shapesXml = renderShapes(shapes, ctx, 2);
    return {
      xml: slideXml(shapesXml, { background: !layout.hasArt }),
      layoutPart: layout.part,
      layout: layout.name,
      kind: index === 0 ? "cover" : slide.kind,
    };
  });

  const keptRels = parseRelationships(presentationRels).filter(
    (rel) =>
      !rel.type.endsWith("/slide") &&
      !rel.type.endsWith("/tags") &&
      !rel.type.endsWith("/customXml"),
  );
  let nextRel = keptRels.reduce((max, rel) => {
    const value = Number(rel.id.match(/rId(\d+)/)?.[1] ?? 0);
    return Math.max(max, value);
  }, 0);
  const slideRels = built.map((_, index) => ({
    id: `rId${++nextRel}`,
    type: `${R_NS}/slide`,
    target: `slides/slide${index + 1}.xml`,
  }));

  const sldMasterIdLst = xmlBlock(presentationPart, "sldMasterIdLst") ||
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`;
  const notesMasterIdLst = xmlBlock(presentationPart, "notesMasterIdLst");
  const sldSz = presentationPart.match(/<p:sldSz\b[^>]*\/>/)?.[0] ??
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen16x9"/>`;
  const notesSz = presentationPart.match(/<p:notesSz\b[^>]*\/>/)?.[0] ??
    `<p:notesSz cx="6858000" cy="9144000"/>`;
  const defaultTextStyle = xmlBlock(presentationPart, "defaultTextStyle");
  const extLst = xmlBlock(presentationPart, "extLst");
  const sldIdLst = built
    .map((_, index) => `<p:sldId id="${256 + index}" r:id="${slideRels[index].id}"/>`)
    .join("");

  const outputPresentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  ${sldMasterIdLst}
  ${notesMasterIdLst}
  <p:sldIdLst>${sldIdLst}</p:sldIdLst>
  ${sldSz}
  ${notesSz}
  ${defaultTextStyle}
  ${extLst}
</p:presentation>`;

  const output = [];
  for (const entry of masterPackage.entries) {
    if (isRemovedMasterPart(entry.name)) continue;
    if (
      entry.name === "[Content_Types].xml" ||
      entry.name === "_rels/.rels" ||
      entry.name === "ppt/presentation.xml" ||
      entry.name === "ppt/_rels/presentation.xml.rels" ||
      entry.name === "docProps/core.xml" ||
      entry.name === "docProps/app.xml"
    ) {
      continue;
    }
    if (entry.name === "ppt/theme/theme1.xml" && theme) {
      output.push({ name: entry.name, data: theme });
      continue;
    }
    output.push(entry);
  }

  output.push({
    name: "[Content_Types].xml",
    data: updateMasterContentTypes(contentTypes, built.length, template),
  });
  output.push({
    name: "_rels/.rels",
    data: relationshipsXml([
      { id: "rId1", type: `${R_NS}/officeDocument`, target: "ppt/presentation.xml" },
      {
        id: "rId2",
        type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
        target: "docProps/core.xml",
      },
      {
        id: "rId3",
        type: `${R_NS}/extended-properties`,
        target: "docProps/app.xml",
      },
    ]),
  });
  output.push({ name: "ppt/presentation.xml", data: outputPresentation });
  output.push({
    name: "ppt/_rels/presentation.xml.rels",
    data: relationshipsXml([...keptRels, ...slideRels]),
  });
  output.push(
    ...built.map((slide, index) => ({
      name: `ppt/slides/slide${index + 1}.xml`,
      data: slide.xml,
    })),
  );
  output.push(
    ...built.map((slide, index) => ({
      name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      data: relationshipsXml([
        {
          id: "rId1",
          type: `${R_NS}/slideLayout`,
          target: `../slideLayouts/slideLayout${
            slide.layoutPart.match(/slideLayout(\d+)\.xml$/)?.[1] ?? "1"
          }.xml`,
        },
      ]),
    })),
  );
  output.push({
    name: "docProps/core.xml",
    data: corePropsXml({
      title,
      subject: template ? "PowerPoint template" : "PowerPoint presentation",
      author,
    }),
  });
  output.push({
    name: "docProps/app.xml",
    data: appPropsXml("PM-Agent Office", { Slides: built.length }),
  });

  return {
    data: createZip(output),
    meta: {
      master: { id: masterPackage.id, layoutMap: masterPackage.layoutMap },
      layouts: built.map((slide) => ({ kind: slide.kind, layout: slide.layout })),
      warnings,
    },
  };
}

/* --------------------------------------------------------- standalone deck */

function presentationXml(slideCount) {
  const slides = Array.from({ length: slideCount }, (_, index) => {
    const slideNumber = index + 1;
    return `<p:sldId id="${256 + index}" r:id="rId${slideNumber + 1}"/>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slides}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}

function presentationRelsXml(slideCount) {
  return relationshipsXml([
    { id: "rId1", type: `${R_NS}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
    ...Array.from({ length: slideCount }, (_, index) => ({
      id: `rId${index + 2}`,
      type: `${R_NS}/slide`,
      target: `slides/slide${index + 1}.xml`,
    })),
  ]);
}

function slideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles>
    <p:titleStyle><a:lvl1pPr algn="l"><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>
    <p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900" algn="l"><a:spcBef><a:spcPct val="20000"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="3200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:bodyStyle>
    <p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:otherStyle>
  </p:txStyles>
</p:sldMaster>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}" type="blank" preserve="1">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function buildStandalonePptx(spec, { template = false, themeXml: theme = themeXml() } = {}) {
  if (!spec || typeof spec !== "object") {
    fail("INVALID_INPUT", "Expected a PPTX specification object.");
  }
  const title = requireString(spec.title, "title", { max: 200 });
  const author = optionalString(spec.author, "author", { max: 120 }) || "PM-Agent";
  const slides = requireArray(spec.slides, "slides", { min: 1, max: 40 });
  const warnings = [];
  const palette = buildPalette({ themeXml: theme });
  const fonts = buildFonts({ themeXml: theme });
  const slideW = toInches(SLIDE_W);
  const slideH = toInches(SLIDE_H);
  const layout = {
    index: 1,
    part: "ppt/slideLayouts/slideLayout1.xml",
    name: "blank",
    type: "blank",
    titlePh: "",
    bodyPh: "",
    titleBox: { x: 0.7, y: 0.4, w: 11.93, h: 0.85 },
    bodyBox: { x: 0.7, y: 1.62, w: 11.93, h: 4.8 },
    obstacles: [],
    hasArt: false,
    hasTitle: false,
    hasBody: false,
    hasSlideNumber: false,
    hasSlideNumberBox: false,
  };

  const normalized = slides.map(normalizeSlide);
  const totalSlides = normalized.length + 1;
  const built = [
    {
      kind: "cover",
      title,
      subtitle: optionalString(spec.subtitle, "subtitle", { max: 500 }),
      meta: optionalString(spec.meta, "meta", { max: 200 }),
    },
    ...normalized,
  ].map((slide, index) => {
    const role = index === 0 ? "cover" : LAYOUT_ROLE[slide.kind] ?? "content";
    const { shapes, ctx } = buildSlideBody({
      slide,
      role,
      layout,
      palette,
      fonts,
      number: index + 1,
      total: totalSlides,
      slideW,
      slideH,
      warnings,
    });
    return {
      xml: slideXml(renderShapes(shapes, ctx, 2)),
      layoutPart: layout.part,
      layout: "blank",
      kind: index === 0 ? "cover" : slide.kind,
    };
  });

  const slideOverrides = built.map((_, index) => ({
    part: `/ppt/slides/slide${index + 1}.xml`,
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  }));

  return {
    data: createZip([
      {
        name: "[Content_Types].xml",
        data: contentTypesXml([
          {
            part: "/ppt/presentation.xml",
            contentType: template
              ? "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml"
              : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
          },
          {
            part: "/ppt/slideMasters/slideMaster1.xml",
            contentType:
              "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
          },
          {
            part: "/ppt/slideLayouts/slideLayout1.xml",
            contentType:
              "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
          },
          {
            part: "/ppt/theme/theme1.xml",
            contentType: "application/vnd.openxmlformats-officedocument.theme+xml",
          },
          ...slideOverrides,
          {
            part: "/docProps/core.xml",
            contentType: "application/vnd.openxmlformats-package.core-properties+xml",
          },
          {
            part: "/docProps/app.xml",
            contentType:
              "application/vnd.openxmlformats-officedocument.extended-properties+xml",
          },
        ]),
      },
      {
        name: "_rels/.rels",
        data: relationshipsXml([
          { id: "rId1", type: `${R_NS}/officeDocument`, target: "ppt/presentation.xml" },
          {
            id: "rId2",
            type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
            target: "docProps/core.xml",
          },
          { id: "rId3", type: `${R_NS}/extended-properties`, target: "docProps/app.xml" },
        ]),
      },
      { name: "ppt/presentation.xml", data: presentationXml(totalSlides) },
      { name: "ppt/_rels/presentation.xml.rels", data: presentationRelsXml(totalSlides) },
      { name: "ppt/slideMasters/slideMaster1.xml", data: slideMasterXml() },
      {
        name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        data: relationshipsXml([
          {
            id: "rId1",
            type: `${R_NS}/slideLayout`,
            target: "../slideLayouts/slideLayout1.xml",
          },
          { id: "rId2", type: `${R_NS}/theme`, target: "../theme/theme1.xml" },
        ]),
      },
      { name: "ppt/slideLayouts/slideLayout1.xml", data: slideLayoutXml() },
      {
        name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        data: relationshipsXml([
          {
            id: "rId1",
            type: `${R_NS}/slideMaster`,
            target: "../slideMasters/slideMaster1.xml",
          },
        ]),
      },
      { name: "ppt/theme/theme1.xml", data: theme },
      ...built.map((slide, index) => ({
        name: `ppt/slides/slide${index + 1}.xml`,
        data: slide.xml,
      })),
      ...built.map((_, index) => ({
        name: `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        data: relationshipsXml([
          {
            id: "rId1",
            type: `${R_NS}/slideLayout`,
            target: "../slideLayouts/slideLayout1.xml",
          },
        ]),
      })),
      {
        name: "docProps/core.xml",
        data: corePropsXml({
          title,
          subject: template ? "PowerPoint template" : "PowerPoint presentation",
          author,
        }),
      },
      {
        name: "docProps/app.xml",
        data: appPropsXml("PM-Agent Office", { Slides: totalSlides }),
      },
    ]),
    meta: {
      master: null,
      layouts: built.map((slide) => ({ kind: slide.kind, layout: slide.layout })),
      warnings,
    },
  };
}

/**
 * Build a .pptx/.potx package. When a master package is supplied, copy its
 * slide master, layouts, theme and media, then compose slides inside the
 * placeholder geometry those layouts define.
 */
export function buildPptx(spec, options = {}) {
  return buildPptxWithMeta(spec, options).data;
}

/**
 * Same as `buildPptx`, plus a build report: the layout chosen per slide and any
 * content warnings (over-long text, too many cards, …) worth surfacing.
 */
export function buildPptxWithMeta(spec, options = {}) {
  if (options.masterPackage) return buildPptxFromMaster(spec, options);
  return buildStandalonePptx(spec, options);
}
