import { readFile } from "node:fs/promises";
import path from "node:path";
import { getMaster } from "./core.mjs";
import { fail } from "./shared.mjs";
import { listZipEntries } from "./zip.mjs";

const THEME_PART = {
  docx: "word/theme/theme1.xml",
  pptx: "ppt/theme/theme1.xml",
  xlsx: "xl/theme/theme1.xml",
};

const DEFAULT_MASTER = {
  docx: "master-docx",
  pptx: "master-pptx",
  xlsx: "master-xlsx",
};

async function resolveMaster(root, id, format) {
  if (!THEME_PART[format]) {
    fail("INVALID_MASTER_FORMAT", `Unsupported master format: ${format}.`, { format });
  }

  const requested = typeof id === "string" ? id.trim() : id;
  const automatic = requested === undefined || requested === null || requested === "";
  const masterId = automatic ? DEFAULT_MASTER[format] : String(requested);

  let master;
  try {
    ({ master } = await getMaster(root, masterId));
  } catch (error) {
    fail(
      error?.code || "MASTER_READ_ERROR",
      error instanceof Error ? error.message : String(error),
      { ...(error?.detail ?? {}), automatic, format, master: masterId },
    );
  }

  if (master.format !== format) {
    fail(
      "MASTER_FORMAT_MISMATCH",
      `Master ${master.id} is ${master.format}, not ${format}.`,
      { id: master.id, expected: format, actual: master.format },
    );
  }

  const full = path.resolve(root, master.path);
  let entries;
  try {
    entries = listZipEntries(await readFile(full));
  } catch (error) {
    fail("MASTER_READ_ERROR", `Cannot read master package ${master.path}.`, {
      id: master.id,
      path: master.path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const themePart = entries.find((entry) => entry.name === THEME_PART[format]);
  if (!themePart) {
    fail("MASTER_THEME_MISSING", `Master ${master.id} has no ${THEME_PART[format]}.`, {
      id: master.id,
      path: master.path,
      part: THEME_PART[format],
    });
  }

  return {
    master,
    entries,
    themeXml: themePart.data.toString("utf8"),
    automatic,
  };
}

/**
 * Resolve a master id and extract only its OOXML theme part.
 * When id is omitted, the format-specific default master is used.
 */
export async function readMasterTheme(root, id, format) {
  const { master, themeXml, automatic } = await resolveMaster(root, id, format);
  return {
    id: master.id,
    path: master.path,
    name: master.name,
    format: master.format,
    themeXml,
    automatic,
  };
}

/**
 * Read a master/template package straight from a file path (no catalog entry).
 * Used by CLI callers that receive a template path, e.g.
 * `build-deck.mjs --template 模板.pptx`.
 */
export async function readMasterPath(file, format = "pptx") {
  if (!THEME_PART[format]) {
    fail("INVALID_MASTER_FORMAT", `Unsupported master format: ${format}.`, { format });
  }
  const absolute = path.resolve(file);
  let entries;
  try {
    entries = listZipEntries(await readFile(absolute));
  } catch (error) {
    fail("MASTER_READ_ERROR", `Cannot read template package ${file}.`, {
      path: file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const themePart = entries.find((entry) => entry.name === THEME_PART[format]);
  if (!themePart) {
    fail("MASTER_THEME_MISSING", `${file} has no ${THEME_PART[format]}; is it a real .pptx?`, {
      path: file,
      part: THEME_PART[format],
    });
  }

  return {
    id: path.basename(absolute, path.extname(absolute)),
    path: absolute,
    name: path.basename(absolute),
    format,
    themeXml: themePart.data.toString("utf8"),
    entries,
    layoutMap: null,
    automatic: false,
    metadata: { id: path.basename(absolute), format, layoutMap: null },
  };
}

/**
 * Resolve a master id and read its complete OOXML package.
 * PowerPoint generation copies the slide master, layouts, theme and media
 * instead of only replacing theme1.xml.
 */
export async function readMasterPackage(root, id, format) {
  const { master, entries, themeXml, automatic } = await resolveMaster(root, id, format);
  return {
    id: master.id,
    path: master.path,
    name: master.name,
    format: master.format,
    themeXml,
    entries,
    layoutMap: master.layoutMap ?? null,
    automatic,
    metadata: master,
  };
}
