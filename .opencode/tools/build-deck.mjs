#!/usr/bin/env node
/**
 * build-deck: Markdown (or a JSON deck spec) → branded .pptx.
 *
 *   node .opencode/tools/build-deck.mjs --markdown deck.md --out out.pptx [--template 模板.pptx]
 *   node .opencode/tools/build-deck.mjs --spec deck.json --out out.pptx
 *
 * The deck is built from the bundled pm-agent Office master
 * (.opencode/templates/master/pm-agent.potx): cover and section pages use
 * `3_自定义版式`, every content page uses `统一模板`, page numbers and the logo
 * come from the master itself. `--template` swaps in a different .pptx package.
 *
 * On success prints one JSON line and exits 0:
 *   {"ok":true,"path":"...","bytes":123,"slides":12,"layouts":[...],"warnings":[]}
 * On failure prints JSON to stderr and exits 1.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPptxWithMeta } from "./lib/pptx.mjs";
import { readMasterPackage, readMasterPath } from "./lib/master.mjs";
import { parseDeckMarkdown } from "./markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (key === "help" || next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function fail(code, message, detail = {}) {
  const payload = { ok: false, code, message, detail };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exit(1);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  process.stdout.write(
    [
      "usage: node .opencode/tools/build-deck.mjs --markdown deck.md --out deck.pptx [--template tpl.pptx]",
      "       node .opencode/tools/build-deck.mjs --spec deck.json --out deck.pptx",
      "",
      "  --markdown  S63 page-shape markdown (## sections, bullets, tables, ```chart fences)",
      "  --spec      JSON deck spec (title/subtitle/slides[])",
      "  --out       output .pptx path (default: deliverables/<name>.pptx)",
      "  --template  optional .pptx to use as the visual master instead of pm-agent.potx",
      "  --title     document title when the markdown has no H1",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

let spec;
let sourceName = "";

if (options.spec) {
  const specPath = path.resolve(String(options.spec));
  if (!fs.existsSync(specPath)) fail("SPEC_NOT_FOUND", `spec file not found: ${specPath}`);
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (error) {
    fail("INVALID_SPEC", `cannot parse ${specPath}: ${error.message}`);
  }
  sourceName = path.basename(specPath, path.extname(specPath));
} else if (options.markdown) {
  const markdownPath = path.resolve(String(options.markdown));
  if (!fs.existsSync(markdownPath)) {
    fail("MARKDOWN_NOT_FOUND", `markdown file not found: ${markdownPath}`);
  }
  const markdown = fs.readFileSync(markdownPath, "utf8");
  spec = parseDeckMarkdown(markdown, { title: options.title ? String(options.title) : "" });
  sourceName = path.basename(markdownPath, path.extname(markdownPath));
} else {
  fail("MISSING_INPUT", "pass --markdown <file.md> or --spec <file.json>.");
}

if (!Array.isArray(spec.slides) || spec.slides.length === 0) {
  fail("EMPTY_DECK", "the deck has no slides; check that the markdown has `##` sections.");
}

const outOption = options.out ? String(options.out) : `deliverables/${sourceName || "deck"}.pptx`;
const outPath = path.isAbsolute(outOption) ? outOption : path.resolve(process.cwd(), outOption);
if (path.extname(outPath).toLowerCase() !== ".pptx") {
  fail("INVALID_OUTPUT", `--out must end with .pptx: ${outPath}`);
}

let masterPackage;
if (options.template) {
  const templatePath = path.resolve(String(options.template));
  if (!fs.existsSync(templatePath)) {
    fail("TEMPLATE_NOT_FOUND", `template not found: ${templatePath}`);
  }
  masterPackage = await readMasterPath(templatePath, "pptx");
} else {
  try {
    masterPackage = await readMasterPackage(repoRoot, undefined, "pptx");
  } catch (error) {
    fail(
      "MASTER_UNAVAILABLE",
      "the bundled Office master could not be read; " +
        "expected .opencode/templates/master/pm-agent.potx (see master/catalog.json).",
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

let deck;
try {
  deck = buildPptxWithMeta(spec, { masterPackage });
} catch (error) {
  fail(error?.code ?? "BUILD_FAILED", error instanceof Error ? error.message : String(error), {
    ...(error?.detail ?? {}),
  });
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, deck.data);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    path: outPath,
    bytes: deck.data.length,
    slides: deck.meta.layouts.length,
    title: spec.title ?? "",
    layouts: deck.meta.layouts,
    warnings: deck.meta.warnings,
  })}\n`,
);
