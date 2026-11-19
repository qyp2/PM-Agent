import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class OfficeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "OfficeError";
    this.code = code;
    this.detail = detail;
  }
}

export function fail(code, message, detail = {}) {
  throw new OfficeError(code, message, detail);
}

export function requireString(value, field, { max = 5000 } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_INPUT", `${field} must be a non-empty string.`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    fail("INVALID_INPUT", `${field} exceeds ${max} characters.`, { field, max });
  }
  return trimmed;
}

export function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  return requireString(value, field, options);
}

export function requireArray(value, field, { min = 1, max = 500 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    fail("INVALID_INPUT", `${field} must be an array with at least ${min} item(s).`, {
      field,
      min,
    });
  }
  if (value.length > max) {
    fail("INVALID_INPUT", `${field} exceeds ${max} items.`, { field, max });
  }
  return value;
}

export function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function xmlText(value) {
  return `<t xml:space="preserve">${xmlEscape(value)}</t>`;
}

export function corePropsXml({ title = "", subject = "", author = "PM-Agent" } = {}) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:subject>${xmlEscape(subject)}</dc:subject>
  <dc:creator>${xmlEscape(author)}</dc:creator>
  <cp:lastModifiedBy>${xmlEscape(author)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

export function appPropsXml(application = "PM-Agent Office", extra = {}) {
  const extraXml = Object.entries(extra)
    .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>${xmlEscape(application)}</Application>
  ${extraXml}
</Properties>`;
}

export function contentTypesXml(overrides, defaults = []) {
  const defaultXml = [
    { extension: "rels", contentType: "application/vnd.openxmlformats-package.relationships+xml" },
    { extension: "xml", contentType: "application/xml" },
    ...defaults,
  ]
    .map(
      (entry) =>
        `<Default Extension="${xmlEscape(entry.extension)}" ContentType="${xmlEscape(entry.contentType)}"/>`,
    )
    .join("");
  const overrideXml = overrides
    .map(
      (entry) =>
        `<Override PartName="${xmlEscape(entry.part)}" ContentType="${xmlEscape(entry.contentType)}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaultXml}
  ${overrideXml}
</Types>`;
}

export function relationshipsXml(relationships) {
  const body = relationships
    .map(
      (rel) =>
        `<Relationship Id="${xmlEscape(rel.id)}" Type="${xmlEscape(rel.type)}" Target="${xmlEscape(rel.target)}"/>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${body}
</Relationships>`;
}

/**
 * Resolve a requested output path under the workspace root.
 * A bare filename defaults to outputs/<filename>.
 */
export function resolveOutputPath(root, requested, extension) {
  const input = requireString(requested, "path", { max: 400 }).replaceAll("\\", "/");
  if (input.split("/").includes("..")) {
    fail("INVALID_PATH", "path must not contain '..'.", { path: input });
  }

  let candidate = input.replace(/^\.\//, "");
  if (!candidate.includes("/")) candidate = `outputs/${candidate}`;
  if (!path.extname(candidate)) candidate += extension;
  if (path.extname(candidate).toLowerCase() !== extension) {
    fail("INVALID_PATH", `path must use the ${extension} extension.`, { path: input });
  }

  const rootAbsolute = path.resolve(root);
  const absolute = path.resolve(rootAbsolute, candidate);
  if (absolute !== rootAbsolute && !absolute.startsWith(rootAbsolute + path.sep)) {
    fail("INVALID_PATH", "path must stay inside the workspace.", { path: input });
  }

  return {
    absolute,
    relative: path.relative(rootAbsolute, absolute).replaceAll("\\", "/"),
  };
}

export async function writeGeneratedFile(
  root,
  requested,
  extension,
  data,
  overwrite = false,
) {
  const target = resolveOutputPath(root, requested, extension);
  if (!overwrite) {
    try {
      await stat(target.absolute);
      fail("FILE_EXISTS", `${target.relative} already exists; choose another path or set overwrite=true.`, {
        path: target.relative,
      });
    } catch (error) {
      if (error instanceof OfficeError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
  }

  await mkdir(path.dirname(target.absolute), { recursive: true });
  await writeFile(target.absolute, data);
  return {
    path: target.relative,
    absolute_path: target.absolute,
    bytes: data.length,
  };
}
