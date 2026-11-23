/**
 * Markdown → deck spec.
 *
 * The S63 page shape, plus the design affordances that keep a generated deck
 * from collapsing into wall-to-wall bullet lists:
 *
 *   ## 页标题             one section = at least one page
 *   副标题                  first short line becomes the page lead
 *   段落 / `- 要点`         body text
 *   ### 小标题 + 要点       2–3 of them become three cards (columns)
 *   `1. 2. 3.` 有序列表      becomes a numbered flow (steps)
 *   `42% 激活率` 2–4 条      becomes metric cards
 *   | 表格 |                becomes a table page
 *   ```chart pie|column|bar becomes a chart page
 *   `> 结论`                becomes the callout strip at the bottom
 *   `---`                   becomes a section divider page
 */

const MAX_BULLETS_PER_SLIDE = 5;
const MAX_TABLE_ROWS = 7;
const MAX_CHART_ROWS = 8;
const SUBTITLE_MAX = 28;
const LEAD_MAX = 64;
const MAX_CARDS = 3;
const MAX_METRICS = 4;

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

const METRIC_PATTERN =
  /^([￥$€]?\d[\d,.]*\s*(?:%|‰|万|亿|千|倍|个月|月|天|周|年|人|次|万元|亿元|pt|pp)?)\s*[：:，,]?\s*(.+)$/;

/** `42% 激活率` → { value: "42%", label: "激活率" }. */
function parseMetric(text) {
  const match = String(text).match(METRIC_PATTERN);
  if (!match) return null;
  const value = match[1].trim();
  const label = match[2].trim();
  if (!/\d/.test(value) || label.length < 2 || label.length > 22) return null;
  return { value, label };
}

/** A bullet list that is really a row of numbers becomes metric cards. */
function metricsFrom(items) {
  if (items.length < 2 || items.length > MAX_METRICS) return null;
  const parsed = [];
  for (const item of items) {
    const metric = parseMetric(item);
    if (!metric) return null;
    parsed.push(metric);
  }
  return parsed;
}

/** `问数 → 出图 → 固化` stays one line: it is a flow, not three bullets. */
function parseSteps(items) {
  return items.map((item) => {
    const text = stripInline(item);
    const split = text.match(/^(.{2,16}?)[：:]\s*(.+)$/);
    if (split) return { title: split[1].trim(), detail: split[2].trim() };
    return { title: text.length > 18 ? `${text.slice(0, 17)}…` : text };
  });
}

/** Parse a single section body into ordered blocks. */
function parseBlocks(lines) {
  const blocks = [];
  let bullets = [];
  let steps = [];
  let paragraph = [];
  let card = null;

  const flushParagraph = () => {
    const value = stripInline(paragraph.join(" "));
    if (value) {
      if (card) card.items.push(value);
      else blocks.push({ type: "para", text: value });
    }
    paragraph = [];
  };
  const closeCard = () => {
    if (!card) return;
    const items = card.items.filter((item) => item !== "");
    if (items.length > 0) {
      blocks.push({ type: "card", heading: card.heading, items });
    }
    card = null;
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      if (card) card.items.push(...bullets);
      else blocks.push({ type: "bullets", items: bullets.slice() });
    }
    bullets = [];
  };
  const flushSteps = () => {
    if (steps.length > 0) {
      closeCard();
      blocks.push({ type: "steps", items: parseSteps(steps) });
    }
    steps = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushBullets();
    closeCard();
    flushSteps();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushAll();
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
        const value = stripInline(body.join(" "));
        if (value) blocks.push({ type: "para", text: value });
      }
      continue;
    }

    if (trimmed === "") {
      flushParagraph();
      flushBullets();
      flushSteps();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      blocks.push({ type: "divider" });
      continue;
    }

    if (/^###\s+/.test(trimmed)) {
      flushAll();
      card = { heading: stripInline(trimmed.replace(/^###\s+/, "")), items: [] };
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      flushAll();
      blocks.push({ type: "quote", text: stripInline(trimmed.replace(/^>\s?/, "")) });
      continue;
    }

    if (trimmed.startsWith("|")) {
      flushAll();
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

    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph();
      flushBullets();
      steps.push(stripInline(trimmed.replace(/^\d+[.)]\s+/, "")));
      continue;
    }

    if (/^([-*+])\s+/.test(trimmed)) {
      flushParagraph();
      flushSteps();
      bullets.push(stripInline(trimmed.replace(/^([-*+])\s+/, "")));
      continue;
    }

    flushBullets();
    flushSteps();
    paragraph.push(trimmed);
  }

  flushAll();
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

const CALLABLE_KINDS = new Set(["bullets", "metrics", "columns", "steps", "table"]);

/** Build the slides of one section, keeping the block order. */
function sectionSlides(heading, blocks, order = 1) {
  const slides = [];
  let lead = "";
  let callout = null;

  // The first paragraph is the page's one-sentence takeaway, if it is short.
  if (blocks.length > 0 && blocks[0].type === "para" && stripInline(blocks[0].text).length <= LEAD_MAX) {
    lead = stripInline(blocks.shift().text);
  }

  const contentCount = () => slides.filter((slide) => slide.layout !== "section").length;

  let textItems = [];
  let cards = [];

  const flushText = () => {
    if (textItems.length === 0) return;
    const metrics = metricsFrom(textItems);
    if (metrics) {
      slides.push({ layout: "metrics", title: continueTitle(heading, contentCount()), metrics });
    } else {
      chunk(textItems, MAX_BULLETS_PER_SLIDE).forEach((page, pageIndex) => {
        const slide = {
          layout: "bullets",
          title: continueTitle(heading, contentCount()),
          bullets: page,
        };
        if (pageIndex === 0 && lead) slide.lead = lead;
        slides.push(slide);
      });
    }
    textItems = [];
  };

  const flushCards = () => {
    if (cards.length === 0) return;
    const groups = chunk(cards, MAX_CARDS);
    groups.forEach((group) => {
      slides.push({
        layout: "columns",
        title: continueTitle(heading, contentCount()),
        columns: group.map((item) => {
          const single = item.items.length === 1 && item.items[0].length > 24;
          return single
            ? { heading: item.heading, text: item.items[0] }
            : { heading: item.heading, bullets: item.items.length > 0 ? item.items : ["未提供"] };
        }),
      });
    });
    cards = [];
  };

  for (const block of blocks) {
    if (block.type === "card") {
      flushText();
      cards.push(block);
      continue;
    }

    if (block.type === "divider") {
      flushText();
      flushCards();
      slides.push({ layout: "section", title: heading, index: order });
      continue;
    }

    if (block.type === "quote") {
      flushText();
      flushCards();
      callout = { label: "结论", text: block.text };
      continue;
    }

    flushCards();

    if (block.type === "para" || block.type === "bullets") {
      const items = block.type === "para" ? [block.text] : block.items;
      for (const item of items) textItems.push(item);
      continue;
    }

    flushText();

    if (block.type === "steps") {
      slides.push({ layout: "steps", title: continueTitle(heading, contentCount()), steps: block.items });
      continue;
    }

    if (block.type === "table") {
      chunk(block.table.rows, MAX_TABLE_ROWS).forEach((rows, pageIndex) => {
        const slide = {
          layout: "table",
          title: continueTitle(heading, contentCount()),
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
        title: continueTitle(heading, contentCount()),
        chart: block.chart,
      };
      if (lead && slides.length === 0) slide.lead = lead;
      slides.push(slide);
    }
  }

  flushText();
  flushCards();

  if (slides.length === 0) {
    if (lead) {
      slides.push({ layout: "quote", title: heading, quote: { text: lead } });
      lead = "";
    } else {
      slides.push({ layout: "bullets", title: heading, bullets: ["未提供"] });
    }
  }

  if (callout) {
    const target = slides.find((slide) => CALLABLE_KINDS.has(slide.layout));
    if (target) target.callout = callout;
    else slides.push({ layout: "quote", title: heading, quote: { text: callout.text } });
  }

  if (lead && !slides.some((slide) => slide.lead)) slides[0].lead = lead;
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

  // A trailing `---` marks the transition into the next section, so the divider
  // page belongs to the section that follows it, not the one before.
  const parsed = sections.map((section) => ({
    heading: section.heading,
    blocks: section.blocks ?? parseBlocks(section.lines),
  }));
  for (let index = 0; index < parsed.length - 1; index += 1) {
    const blocks = parsed[index].blocks;
    if (blocks.length > 0 && blocks[blocks.length - 1].type === "divider") {
      blocks.pop();
      parsed[index + 1].blocks.unshift({ type: "divider" });
    }
  }

  const slides = [];
  parsed.forEach((section, sectionIndex) => {
    if (section.blocks.length === 0) return;
    slides.push(...sectionSlides(section.heading, section.blocks, sectionIndex + 1));
  });

  const agenda = sections.length >= 5
    ? [{ layout: "agenda", title: "目录", items: sections.map((section) => section.heading) }]
    : [];

  return {
    title: title || options.title || "汇报材料",
    subtitle,
    slides: [...agenda, ...slides],
  };
}
