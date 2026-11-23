import assert from "node:assert/strict";
import test from "node:test";
import { buildPptxWithMeta } from "./lib/pptx.mjs";
import { readMasterPackage } from "./lib/master.mjs";
import { parseDeckMarkdown } from "./markdown.mjs";

const SAMPLE = `# 季度复盘

一句话说明这次复盘的范围。

## 结论

- 激活率 42%，环比 -3pt
- 留存 31%，主要流失在首周

## 门禁状态

| 门禁 | 状态 |
| --- | --- |
| C1 | 缺失 |
| C2 | 通过 |

## 用户结构

\`\`\`chart pie 单位:%
| 客群 | 占比 |
| --- | --- |
| 家庭 | 46 |
| 银发 | 32 |
| 政企 | 22 |
\`\`\`

## 月度趋势

\`\`\`chart column 单位:万
| 月份 | 新增 |
| --- | --- |
| 9 月 | 118 |
| 10 月 | 146 |
\`\`\`

## 渠道对比

\`\`\`chart bar
| 渠道 | 留存 |
| --- | --- |
| 营业厅 | 42 |
| App | 28 |
\`\`\`
`;

test("parseDeckMarkdown keeps sections, subtitle, bullets, tables and charts", () => {
  const spec = parseDeckMarkdown(SAMPLE);
  assert.equal(spec.title, "季度复盘");
  assert.equal(spec.subtitle, "一句话说明这次复盘的范围。");

  const kinds = spec.slides.map((slide) => slide.layout);
  assert.ok(kinds.includes("agenda"), "six sections get a contents page");
  assert.ok(kinds.includes("table"));
  assert.equal(kinds.filter((kind) => kind === "chart").length, 3);

  const pie = spec.slides.find((slide) => slide.chart?.kind === "pie");
  assert.deepEqual(pie.chart.rows[0], { label: "家庭", value: 46 });
  assert.equal(pie.chart.unit, "%");

  const bullets = spec.slides.find((slide) => slide.layout === "bullets" && slide.title === "结论");
  assert.equal(bullets.bullets.length, 2);
  assert.ok(bullets.bullets[0].includes("激活率 42%"));
});

test("parseDeckMarkdown continues long lists and keeps table headers", () => {
  const markdown = [
    "## 清单",
    "",
    ...Array.from({ length: 11 }, (_, index) => `- 要点 ${index + 1}`),
    "",
    "| 名称 | 值 |",
    "| --- | --- |",
    ...Array.from({ length: 9 }, (_, index) => `| 行 ${index + 1} | ${index} |`),
  ].join("\n");

  const spec = parseDeckMarkdown(markdown, { title: "长清单" });
  const bulletPages = spec.slides.filter((slide) => slide.layout === "bullets");
  assert.ok(bulletPages.length >= 3, "11 bullets split across pages");
  assert.match(bulletPages[1].title, /（续）$/);

  const tablePages = spec.slides.filter((slide) => slide.layout === "table");
  assert.equal(tablePages.length, 2);
  assert.deepEqual(tablePages[0].table.headers, ["名称", "值"]);
  assert.equal(tablePages[0].table.rows.length, 7);
  assert.match(tablePages[1].title, /（续）$/);
});

test("parseDeckMarkdown turns card, metric, step and quote syntax into designed pages", () => {
  const markdown = [
    "# 复盘",
    "",
    "## 关键数字",
    "",
    "- 1,633万 三年 ARR",
    "- 4–5个月 回本周期",
    "- 46% 家庭占比",
    "",
    "> 结论：先把门禁补齐再放量",
    "",
    "## 闭环",
    "",
    "1. 问数：一句话把问题转成查询",
    "2. 出图：30 秒给出可解释图表",
    "3. 推送：按周推到群与看板",
    "",
    "## 主线",
    "",
    "### 订阅为体",
    "",
    "按坐席年付，覆盖 60% 收入",
    "",
    "### 用量为阀",
    "",
    "超量按次计费，抑制滥用",
    "",
    "---",
    "",
    "## 风险",
    "",
    "- R1 竞品免费化挤压付费卖点",
  ].join("\n");

  const spec = parseDeckMarkdown(markdown, { title: "复盘" });
  const kinds = spec.slides.map((slide) => slide.layout);

  assert.ok(kinds.includes("metrics"), "number-first bullets become metric cards");
  assert.equal(kinds.filter((kind) => kind === "steps").length, 1);
  assert.equal(kinds.filter((kind) => kind === "columns").length, 1);
  assert.equal(kinds.filter((kind) => kind === "section").length, 1);
  assert.equal(kinds.filter((kind) => kind === "bullets").length, 1);

  const metrics = spec.slides.find((slide) => slide.layout === "metrics");
  assert.deepEqual(metrics.metrics[0], { value: "1,633万", label: "三年 ARR" });
  assert.equal(metrics.callout.label, "结论", "the > quote becomes the bottom callout");
  assert.match(metrics.callout.text, /门禁补齐/);

  const columns = spec.slides.find((slide) => slide.layout === "columns");
  assert.equal(columns.columns.length, 2);
  assert.equal(columns.columns[0].heading, "订阅为体");

  const steps = spec.slides.find((slide) => slide.layout === "steps");
  assert.equal(steps.steps[0].title, "问数");
  assert.match(steps.steps[0].detail, /转成查询/);

  const divider = spec.slides.find((slide) => slide.layout === "section");
  assert.equal(divider.title, "风险", "a trailing --- opens the next section");
  assert.equal(divider.index, 4);
});

test("build-deck renders the markdown through the bundled master", async () => {
  const spec = parseDeckMarkdown(SAMPLE);
  const masterPackage = await readMasterPackage(process.cwd(), undefined, "pptx");
  const deck = buildPptxWithMeta(spec, { masterPackage });

  assert.ok(deck.data.length > 1_000_000, "the master package is embedded");
  // The builder prepends the cover page from spec.title.
  assert.equal(deck.meta.layouts.length, spec.slides.length + 1);
  assert.deepEqual(deck.meta.layouts[0].layout, "3_自定义版式");
  assert.ok(
    deck.meta.layouts.slice(1).every((item) => item.layout === "统一模板"),
    "content pages all use the 统一模板 layout",
  );
  assert.deepEqual(deck.meta.warnings, []);
});
