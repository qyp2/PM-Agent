import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const TEMPLATE_FORMATS = ["docx", "pptx", "xlsx"];
const FORMAT_SET = new Set(TEMPLATE_FORMATS);
const MASTER_EXT = { docx: ".dotx", pptx: ".potx", xlsx: ".xltx" };
const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const FIELD_RE = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER_RE = /\{\{([a-z][a-z0-9_]*)\}\}/g;
const COLUMN_TYPES = new Set([
  "text",
  "number",
  "integer",
  "percent",
  "currency",
  "date",
  "boolean",
]);

export class TemplateError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, message, detail = {}) {
  throw new TemplateError(code, message, detail);
}

function requireText(value, field, { max = 500 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_TEMPLATE", `${field} must be a non-empty string.`, { field });
  }
  const text = value.trim();
  if (text.length > max) {
    fail("INVALID_TEMPLATE", `${field} exceeds ${max} characters.`, { field, max });
  }
  return text;
}

function requireArray(value, field, { min = 1, max = 100 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    fail("INVALID_TEMPLATE", `${field} must be an array with at least ${min} item(s).`, {
      field,
      min,
    });
  }
  if (value.length > max) {
    fail("INVALID_TEMPLATE", `${field} exceeds ${max} items.`, { field, max });
  }
  return value;
}

export function templateRoot(root) {
  return path.join(root, ".opencode", "templates");
}

export function assertTemplateId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    fail("INVALID_TEMPLATE_ID", "Template id must match ^[a-z][a-z0-9-]{1,63}$.", {
      id,
    });
  }
  return id;
}

function resolveTemplateFile(root, file) {
  if (typeof file !== "string" || file.trim() === "" || !file.endsWith(".json")) {
    fail("INVALID_TEMPLATE_PATH", "Template file must be a relative .json path.", { file });
  }
  const base = templateRoot(root);
  const full = path.resolve(base, file);
  const relative = path.relative(base, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("INVALID_TEMPLATE_PATH", "Template file must stay inside .opencode/templates.", {
      file,
    });
  }
  return full;
}

export function masterRoot(root) {
  return path.join(templateRoot(root), "master");
}

export function assertMasterId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    fail("INVALID_MASTER_ID", "Master id must match ^[a-z][a-z0-9-]{1,63}$.", { id });
  }
  return id;
}

function resolveMasterFile(root, entry) {
  if (
    typeof entry.file !== "string" ||
    entry.file.trim() === "" ||
    !MASTER_EXT[entry.format]
  ) {
    fail("INVALID_MASTER_PATH", "Master file must be a relative Office template path.", {
      file: entry.file,
    });
  }
  if (path.extname(entry.file).toLowerCase() !== MASTER_EXT[entry.format]) {
    fail("INVALID_MASTER_PATH", `Master file must use ${MASTER_EXT[entry.format]}.`, {
      file: entry.file,
      format: entry.format,
    });
  }
  const base = masterRoot(root);
  const full = path.resolve(base, entry.file);
  const relative = path.relative(base, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("INVALID_MASTER_PATH", "Master file must stay inside .opencode/templates/master.", {
      file: entry.file,
    });
  }
  return full;
}

async function readJson(file, code = "INVALID_TEMPLATE_JSON") {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    fail("TEMPLATE_READ_ERROR", `Cannot read ${path.basename(file)}.`, {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(code, `Invalid JSON in ${path.basename(file)}.`, {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function loadCatalog(root) {
  const catalog = await readJson(path.join(templateRoot(root), "catalog.json"));
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.templates)) {
    fail("INVALID_CATALOG", "catalog.json must contain a templates array.");
  }
  const ids = new Set();
  for (const entry of catalog.templates) {
    if (!entry || typeof entry !== "object") {
      fail("INVALID_CATALOG", "Each catalog entry must be an object.");
    }
    assertTemplateId(entry.id);
    if (ids.has(entry.id)) {
      fail("DUPLICATE_TEMPLATE_ID", `Duplicate template id: ${entry.id}.`, { id: entry.id });
    }
    ids.add(entry.id);
    resolveTemplateFile(root, entry.file);
  }
  return catalog;
}

export async function loadMasterCatalog(root) {
  const catalog = await readJson(
    path.join(masterRoot(root), "catalog.json"),
    "INVALID_MASTER_CATALOG",
  );
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.masters)) {
    fail("INVALID_MASTER_CATALOG", "master/catalog.json must contain a masters array.");
  }
  const ids = new Set();
  for (const entry of catalog.masters) {
    if (!entry || typeof entry !== "object") {
      fail("INVALID_MASTER_CATALOG", "Each master entry must be an object.");
    }
    assertMasterId(entry.id);
    if (ids.has(entry.id)) {
      fail("DUPLICATE_MASTER_ID", `Duplicate master id: ${entry.id}.`, { id: entry.id });
    }
    ids.add(entry.id);
    if (!FORMAT_SET.has(entry.format)) {
      fail("INVALID_MASTER", "Master format must be docx, pptx or xlsx.", {
        id: entry.id,
        format: entry.format,
      });
    }
    for (const field of ["name", "description", "version", "owner", "updated"]) {
      requireText(entry[field], `masters.${entry.id}.${field}`, { max: 500 });
    }
    const tags = requireArray(entry.tags, `masters.${entry.id}.tags`, { min: 1, max: 20 });
    tags.forEach((tag, index) =>
      requireText(tag, `masters.${entry.id}.tags[${index}]`, { max: 50 }),
    );
    if (entry.layoutMap !== undefined) {
      if (!entry.layoutMap || typeof entry.layoutMap !== "object" || Array.isArray(entry.layoutMap)) {
        fail("INVALID_MASTER", "Master layoutMap must be an object.", { id: entry.id });
      }
      for (const role of ["cover", "content", "section"]) {
        if (entry.layoutMap[role] !== undefined) {
          requireText(entry.layoutMap[role], `masters.${entry.id}.layoutMap.${role}`, {
            max: 200,
          });
        }
      }
    }
    resolveMasterFile(root, entry);
  }
  return catalog;
}

function masterSummary(root, entry, theme) {
  const file = resolveMasterFile(root, entry);
  return {
    id: entry.id,
    format: entry.format,
    file: entry.file,
    path: path.relative(root, file).replaceAll("\\", "/"),
    name: entry.name,
    description: entry.description,
    tags: entry.tags,
    version: entry.version,
    owner: entry.owner,
    updated: entry.updated,
    slides: entry.slides,
    layouts: entry.layouts,
    layoutMap: entry.layoutMap,
    theme: entry.theme && typeof entry.theme === "object" ? entry.theme : theme,
  };
}

export async function listMasters(root, options = {}) {
  const catalog = await loadMasterCatalog(root);
  const format = options.format;
  if (format !== undefined && !FORMAT_SET.has(format)) {
    fail("INVALID_INPUT", "format must be docx, pptx or xlsx.", { format });
  }
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  const masters = catalog.masters
    .filter((entry) => format === undefined || entry.format === format)
    .filter((entry) => {
      if (!query) return true;
      return [entry.id, entry.name, entry.description, ...entry.tags]
        .join(" ")
        .toLowerCase()
        .includes(query);
    })
    .map((entry) => masterSummary(root, entry, catalog.theme));

  return {
    ok: true,
    catalogVersion: catalog.version,
    updated: catalog.updated,
    count: masters.length,
    theme: catalog.theme,
    masters,
  };
}

export async function getMaster(root, id) {
  assertMasterId(id);
  const catalog = await loadMasterCatalog(root);
  const entry = catalog.masters.find((item) => item.id === id);
  if (!entry) {
    fail("MASTER_NOT_FOUND", `Master not found: ${id}.`, { id });
  }
  const file = resolveMasterFile(root, entry);
  try {
    await stat(file);
  } catch (error) {
    fail("MASTER_READ_ERROR", `Cannot read ${path.basename(file)}.`, {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ok: true,
    catalogVersion: catalog.version,
    master: masterSummary(root, entry, catalog.theme),
  };
}

function validateDocxContent(content) {
  requireText(content.title, "content.title", { max: 200 });
  const sections = requireArray(content.sections, "content.sections", { min: 1, max: 100 });
  sections.forEach((section, index) => {
    if (!section || typeof section !== "object") {
      fail("INVALID_TEMPLATE", `content.sections[${index}] must be an object.`);
    }
    if (section.heading !== undefined) {
      requireText(section.heading, `content.sections[${index}].heading`, { max: 200 });
    }
    if (section.level !== undefined) {
      if (![1, 2, 3].includes(section.level)) {
        fail("INVALID_TEMPLATE", `content.sections[${index}].level must be 1, 2 or 3.`);
      }
    }
    for (const key of ["paragraphs", "bullets"]) {
      if (section[key] !== undefined) {
        const values = requireArray(section[key], `content.sections[${index}].${key}`, {
          min: 0,
          max: 100,
        });
        values.forEach((value, valueIndex) => {
          requireText(value, `content.sections[${index}].${key}[${valueIndex}]`, {
            max: 5000,
          });
        });
      }
    }
    if (section.table !== undefined) {
      const table = section.table;
      if (!table || typeof table !== "object") {
        fail("INVALID_TEMPLATE", `content.sections[${index}].table must be an object.`);
      }
      const headers = requireArray(table.headers, `content.sections[${index}].table.headers`, {
        min: 1,
        max: 12,
      });
      headers.forEach((header, headerIndex) => {
        requireText(header, `content.sections[${index}].table.headers[${headerIndex}]`, {
          max: 200,
        });
      });
      if (!Array.isArray(table.rows)) {
        fail("INVALID_TEMPLATE", `content.sections[${index}].table.rows must be an array.`);
      }
    }
    const hasBody =
      section.heading !== undefined ||
      (section.paragraphs?.length ?? 0) > 0 ||
      (section.bullets?.length ?? 0) > 0 ||
      section.table !== undefined;
    if (!hasBody) {
      fail("INVALID_TEMPLATE", `content.sections[${index}] is empty.`);
    }
  });
}

const PPTX_LAYOUTS = [
  "bullets",
  "content",
  "section",
  "agenda",
  "metrics",
  "columns",
  "steps",
  "table",
  "quote",
  "closing",
];

function validatePptxContent(content) {
  requireText(content.title, "content.title", { max: 200 });
  if (content.subtitle !== undefined) {
    requireText(content.subtitle, "content.subtitle", { max: 500 });
  }
  const slides = requireArray(content.slides, "content.slides", { min: 1, max: 40 });
  slides.forEach((slide, index) => {
    if (!slide || typeof slide !== "object") {
      fail("INVALID_TEMPLATE", `content.slides[${index}] must be an object.`);
    }
    requireText(slide.title, `content.slides[${index}].title`, { max: 200 });
    if (slide.bullets !== undefined) {
      const bullets = requireArray(slide.bullets, `content.slides[${index}].bullets`, {
        min: 0,
        max: 8,
      });
      bullets.forEach((bullet, bulletIndex) => {
        if (typeof bullet === "object" && bullet !== null) {
          requireText(bullet.text, `content.slides[${index}].bullets[${bulletIndex}].text`, {
            max: 500,
          });
          return;
        }
        requireText(bullet, `content.slides[${index}].bullets[${bulletIndex}]`, {
          max: 500,
        });
      });
    }
    if (slide.layout !== undefined && !PPTX_LAYOUTS.includes(slide.layout)) {
      fail(
        "INVALID_TEMPLATE",
        `content.slides[${index}].layout must be one of ${PPTX_LAYOUTS.join(", ")}.`,
      );
    }
    if (slide.metrics !== undefined) {
      const metrics = requireArray(slide.metrics, `content.slides[${index}].metrics`, {
        min: 1,
        max: 4,
      });
      metrics.forEach((metric, metricIndex) => {
        if (!metric || typeof metric !== "object") {
          fail(
            "INVALID_TEMPLATE",
            `content.slides[${index}].metrics[${metricIndex}] must be an object.`,
          );
        }
        requireText(metric.value, `content.slides[${index}].metrics[${metricIndex}].value`, {
          max: 40,
        });
        requireText(metric.label, `content.slides[${index}].metrics[${metricIndex}].label`, {
          max: 80,
        });
      });
    }
    if (slide.columns !== undefined) {
      const columns = requireArray(slide.columns, `content.slides[${index}].columns`, {
        min: 2,
        max: 3,
      });
      columns.forEach((column, columnIndex) => {
        requireText(column.heading, `content.slides[${index}].columns[${columnIndex}].heading`, {
          max: 60,
        });
        if (column.bullets !== undefined) {
          const items = requireArray(
            column.bullets,
            `content.slides[${index}].columns[${columnIndex}].bullets`,
            { min: 0, max: 6 },
          );
          items.forEach((item, itemIndex) => {
            requireText(
              item,
              `content.slides[${index}].columns[${columnIndex}].bullets[${itemIndex}]`,
              { max: 120 },
            );
          });
        }
      });
    }
    if (slide.steps !== undefined) {
      const steps = requireArray(slide.steps, `content.slides[${index}].steps`, {
        min: 2,
        max: 5,
      });
      steps.forEach((step, stepIndex) => {
        requireText(step.title, `content.slides[${index}].steps[${stepIndex}].title`, { max: 40 });
      });
    }
    if (slide.table !== undefined) {
      const table = slide.table;
      if (!table || typeof table !== "object") {
        fail("INVALID_TEMPLATE", `content.slides[${index}].table must be an object.`);
      }
      const headers = requireArray(table.headers, `content.slides[${index}].table.headers`, {
        min: 1,
        max: 6,
      });
      headers.forEach((header, headerIndex) => {
        requireText(header, `content.slides[${index}].table.headers[${headerIndex}]`, { max: 40 });
      });
      requireArray(table.rows, `content.slides[${index}].table.rows`, { min: 1, max: 12 });
    }
    if (slide.quote !== undefined) {
      requireText(slide.quote?.text, `content.slides[${index}].quote.text`, { max: 300 });
    }
    if (slide.callout !== undefined) {
      requireText(slide.callout?.text, `content.slides[${index}].callout.text`, { max: 300 });
    }
  });
}

function validateXlsxContent(content) {
  if (content.title !== undefined) {
    requireText(content.title, "content.title", { max: 200 });
  }
  const sheets = requireArray(content.sheets, "content.sheets", { min: 1, max: 10 });
  sheets.forEach((sheet, sheetIndex) => {
    if (!sheet || typeof sheet !== "object") {
      fail("INVALID_TEMPLATE", `content.sheets[${sheetIndex}] must be an object.`);
    }
    requireText(sheet.name, `content.sheets[${sheetIndex}].name`, { max: 31 });
    const columns = requireArray(sheet.columns, `content.sheets[${sheetIndex}].columns`, {
      min: 1,
      max: 50,
    });
    columns.forEach((column, columnIndex) => {
      if (!column || typeof column !== "object") {
        fail(
          "INVALID_TEMPLATE",
          `content.sheets[${sheetIndex}].columns[${columnIndex}] must be an object.`,
        );
      }
      requireText(
        column.header,
        `content.sheets[${sheetIndex}].columns[${columnIndex}].header`,
        { max: 200 },
      );
      if (column.type !== undefined && !COLUMN_TYPES.has(column.type)) {
        fail(
          "INVALID_TEMPLATE",
          `content.sheets[${sheetIndex}].columns[${columnIndex}].type is invalid.`,
        );
      }
    });
    if (sheet.rows !== undefined) {
      if (!Array.isArray(sheet.rows)) {
        fail("INVALID_TEMPLATE", `content.sheets[${sheetIndex}].rows must be an array.`);
      }
      sheet.rows.forEach((row, rowIndex) => {
        if (!Array.isArray(row)) {
          fail(
            "INVALID_TEMPLATE",
            `content.sheets[${sheetIndex}].rows[${rowIndex}] must be an array.`,
          );
        }
      });
    }
  });
}

export function validateTemplate(template, entry = {}) {
  if (!template || typeof template !== "object") {
    fail("INVALID_TEMPLATE", "Template must be an object.");
  }
  assertTemplateId(template.id);
  if (entry.id !== undefined && entry.id !== template.id) {
    fail("INVALID_TEMPLATE", "Catalog id does not match template id.", {
      catalogId: entry.id,
      templateId: template.id,
    });
  }
  if (!FORMAT_SET.has(template.format)) {
    fail("INVALID_TEMPLATE", "Template format must be docx, pptx or xlsx.", {
      format: template.format,
    });
  }
  if (template.master !== undefined) assertMasterId(template.master);
  if (entry.format !== undefined && entry.format !== template.format) {
    fail("INVALID_TEMPLATE", "Catalog format does not match template format.", {
      catalogFormat: entry.format,
      templateFormat: template.format,
    });
  }
  for (const field of ["name", "category", "description", "version", "owner", "updated"]) {
    requireText(template[field], field, { max: 500 });
  }
  if (!Array.isArray(template.tags) || template.tags.length === 0) {
    fail("INVALID_TEMPLATE", "tags must be a non-empty array.");
  }
  template.tags.forEach((tag, index) => requireText(tag, `tags[${index}]`, { max: 50 }));

  const fields = requireArray(template.fields, "fields", { min: 1, max: 100 });
  const fieldKeys = new Set();
  fields.forEach((field, index) => {
    if (!field || typeof field !== "object") {
      fail("INVALID_TEMPLATE", `fields[${index}] must be an object.`);
    }
    if (typeof field.key !== "string" || !FIELD_RE.test(field.key)) {
      fail("INVALID_TEMPLATE", `fields[${index}].key is invalid.`, { key: field.key });
    }
    if (fieldKeys.has(field.key)) {
      fail("INVALID_TEMPLATE", `Duplicate field key: ${field.key}.`, { key: field.key });
    }
    fieldKeys.add(field.key);
    requireText(field.label, `fields[${index}].label`, { max: 200 });
  });

  if (!template.content || typeof template.content !== "object") {
    fail("INVALID_TEMPLATE", "content must be an object.");
  }
  if (template.format === "docx") validateDocxContent(template.content);
  else if (template.format === "pptx") validatePptxContent(template.content);
  else validateXlsxContent(template.content);

  if (template.instructions !== undefined) {
    const instructions = requireArray(template.instructions, "instructions", {
      min: 1,
      max: 20,
    });
    instructions.forEach((instruction, index) =>
      requireText(instruction, `instructions[${index}]`, { max: 500 }),
    );
  }

  const found = [
    ...JSON.stringify(template.content).matchAll(PLACEHOLDER_RE),
  ].map((match) => match[1]);
  const undeclared = [...new Set(found)].filter((key) => !fieldKeys.has(key));
  if (undeclared.length > 0) {
    fail("UNDECLARED_PLACEHOLDER", "Template uses placeholders not declared in fields.", {
      fields: undeclared,
    });
  }

  return template;
}

function summary(template) {
  return {
    id: template.id,
    name: template.name,
    format: template.format,
    category: template.category,
    description: template.description,
    tags: template.tags,
    version: template.version,
    owner: template.owner,
    updated: template.updated,
    master: template.master ?? null,
    fieldCount: template.fields.length,
  };
}

async function readTemplate(root, entry) {
  const file = resolveTemplateFile(root, entry.file);
  const template = await readJson(file);
  validateTemplate(template, entry);
  return template;
}

export async function listTemplates(root, options = {}) {
  const catalog = await loadCatalog(root);
  const format = options.format;
  if (format !== undefined && !FORMAT_SET.has(format)) {
    fail("INVALID_INPUT", "format must be docx, pptx or xlsx.", { format });
  }
  const query = typeof options.query === "string" ? options.query.trim().toLowerCase() : "";
  const category =
    typeof options.category === "string" ? options.category.trim().toLowerCase() : "";

  const templates = [];
  for (const entry of catalog.templates) {
    const template = await readTemplate(root, entry);
    if (format !== undefined && template.format !== format) continue;
    if (category && !template.category.toLowerCase().includes(category)) continue;
    if (query) {
      const haystack = [
        template.id,
        template.name,
        template.description,
        template.category,
        template.tags.join(" "),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    templates.push(summary(template));
  }

  return {
    ok: true,
    catalogVersion: catalog.version,
    updated: catalog.updated,
    count: templates.length,
    templates,
  };
}

export async function getTemplate(root, id) {
  assertTemplateId(id);
  const catalog = await loadCatalog(root);
  const entry = catalog.templates.find((item) => item.id === id);
  if (!entry) {
    fail("TEMPLATE_NOT_FOUND", `Template not found: ${id}.`, { id });
  }
  const template = await readTemplate(root, entry);
  const master = template.master ? (await getMaster(root, template.master)).master : null;
  return {
    ok: true,
    catalogVersion: catalog.version,
    template,
    master,
  };
}
