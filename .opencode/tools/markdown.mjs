/**
 * Markdown → deck spec.
 *
 * The S63 page shape: every `##` is a section, the first short line under it is
 * the subtitle, `-` lines are bullets, a `|` block is a table, and a
 * ```chart fence (pie / column / bar) is a chart. A section may produce several
 * slides: tables and charts get their own page, long bullet lists continue on
 * 「（续）」 pages.
 */

const MAX_BULLETS_PER_SLIDE = 5;
const MAX_TABLE_ROWS = 7;
const MAX_CHART_ROWS = 8;
const SUBTITLE_MAX = 28;

function stripInline(value) {
  return String(value ?? "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

function isSubtitle(line) {
  const text = stripInline(line);
  return text.length > 0 && text.length <= SUBTITLE_MAX && !/[。！？.!?：:；;]$/.test(text);
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => stripInline(cell));
}

function isSeparatorRow(line) {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());
}

function parseTable(lines) {
  const rows = lines.filter((line) => !isSeparatorRow(line)).map(splitRow);
  if (rows.length === 0) return null;
  const [headers, ...body] = rows;
  return { headers, rows: body.filter((row) => row.some((cell) => cell !== "")) };
}

function parseChart(header, lines) {
  const kindLine = header.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const kind = ["pie", "column", "bar"].includes(kindLine) ? kindLine : "bar";
  const table = parseTable(lines);
  if (!table || table.rows.length === 0) return null;

  const unitMatch = header.match(/单位\s*[:：]\s*(\S+)/);
  const rows = table.rows
    .map((row) => {
      const label = row[0] ?? "";
      const raw = (row[1] ?? "").replace(/[,，\s]/g, "");
      const numeric = raw.match(/-?\d+(\.\d+)?/);
      return numeric ? { label, value: Number(numeric[0]) } : null;
    })
    .filter(Boolean)
    .slice(0, MAX_CHART_ROWS);

  if (rows.length === 0) return null;
  return { kind, unit: unitMatch ? unitMatch[1] : "", rows };
}

/** Parse a single section body into ordered blocks. */
function parseBlocks(lines) {
  const blocks = [];
  let buffer = [];
  let paragraph = [];

  const flushParagraph = () => {
    const text = stripInline(paragraph.join(" "));
    if (text) blocks.push({ type: "para", text });
    paragraph = [];
  };
  const flushList = () => {
    if (buffer.length > 0) blocks.push({ type: "bullets", items: buffer.slice() });
    buffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      const fence = trimmed.slice(3).trim();
      // Accept both ```chart pie and ```pie (S63 writes the former).
      const header = fence.replace(/^chart\b/i, "").trim();
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        body.push(lines[index]);
        index += 1;
      }
      if (/^(pie|column|bar)\b/i.test(header)) {
        const chart = parseChart(header, body);
        if (chart) blocks.push({ type: "chart", chart });
      } else {
        // Unknown fence: keep its text so nothing silently disappears.
        const text = stripInline(body.join(" "));
        if (text) blocks.push({ type: "para", text });
      }
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }

    if (trimmed.startsWith("|")) {
      flushParagraph();
      flushList();
      const tableLines = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      const table = parseTable(tableLines);
      if (table) blocks.push({ type: "table", table });
      continue;
    }

    if (/^([-*+]|\d+[.)])\s+/.test(trimmed)) {
      flushParagraph();
      buffer.push(stripInline(trimmed.replace(/^([-*+]|\d+[.)])\s+/, "")));
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function continueTitle(title, index) {
  return index === 0 ? title : `${title}（续）`;
}

/** Build the slides of one section, keeping the block order. */
function sectionSlides(heading, blocks) {
  const slides = [];
  let lead = "";
  if (blocks.length > 0 && blocks[0].type === "para" && isSubtitle(blocks[0].text)) {
    lead = blocks.shift().text;
  }

  const textItems = [];
  const flushText = () => {
    if (textItems.length === 0) return;
    const pages = chunk(textItems, MAX_BULLETS_PER_SLIDE);
    pages.forEach((page, pageIndex) => {
      const slide = {
        layout: "bullets",
        title: continueTitle(heading, slides.length),
        bullets: page,
      };
      if (pageIndex === 0 && lead) slide.lead = lead;
      slides.push(slide);
    });
    textItems.length = 0;
  };

  for (const block of blocks) {
    if (block.type === "para" || block.type === "bullets") {
      const items = block.type === "para" ? [block.text] : block.items;
      for (const item of items) textItems.push(item);
      continue;
    }

    flushText();

    if (block.type === "table") {
      const pages = chunk(block.table.rows, MAX_TABLE_ROWS);
      pages.forEach((rows, pageIndex) => {
        const slide = {
          layout: "table",
          title: continueTitle(heading, slides.length),
          table: { headers: block.table.headers, rows },
        };
        if (pageIndex === 0 && lead && slides.length === 0) slide.lead = lead;
        slides.push(slide);
      });
      continue;
    }

    if (block.type === "chart") {
      const slide = {
        layout: "chart",
        title: continueTitle(heading, slides.length),
        chart: block.chart,
      };
      if (lead && slides.length === 0) slide.lead = lead;
      slides.push(slide);
    }
  }

  flushText();

  if (slides.length === 0) {
    slides.push({ layout: "bullets", title: heading, bullets: ["未提供"] });
  }
  return slides;
}

/**
 * @param {string} markdown
 * @param {{title?: string}} [options]
 * @returns {{title: string, subtitle: string, slides: Array<object>}}
 */
export function parseDeckMarkdown(markdown, options = {}) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  let title = stripInline(options.title ?? "");
  const preamble = [];
  const sections = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      current = { heading: stripInline(trimmed.replace(/^##\s+/, "")), lines: [] };
      sections.push(current);
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      if (!title) title = stripInline(trimmed.replace(/^#\s+/, ""));
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  const preambleBlocks = parseBlocks(preamble);
  const subtitle =
    preambleBlocks.find((block) => block.type === "para" && block.text !== title)?.text ?? "";

  if (sections.length === 0) {
    // No `##` at all: treat the whole document as one section.
    const blocks = parseBlocks(lines.filter((line) => !/^#\s+/.test(line.trim())));
    sections.push({ heading: title || "正文", blocks });
  }

  const slides = [];
  for (const section of sections) {
    const blocks = section.blocks ?? parseBlocks(section.lines);
    slides.push(...sectionSlides(section.heading, blocks));
  }

  const agenda = sections.length >= 5
    ? [{ layout: "agenda", title: "目录", items: sections.map((section) => section.heading) }]
    : [];

  return {
    title: title || options.title || "汇报材料",
    subtitle,
    slides: [...agenda, ...slides],
  };
}
