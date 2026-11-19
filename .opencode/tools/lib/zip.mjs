/**
 * Minimal ZIP writer and reader using the STORE method (no compression).
 *
 * OOXML packages (.docx/.pptx/.xlsx) are ZIP archives. Office accepts stored
 * entries, and avoiding compression keeps the writer dependency-free. The
 * reader is more permissive: Word/PowerPoint/Excel and most other producers
 * write DEFLATE (method 8) entries, sometimes with a trailing data descriptor,
 * so reading goes through the central directory and inflates as needed.
 */
import { inflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function normalizeName(name) {
  const normalized = String(name).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`Invalid ZIP entry name: ${name}`);
  }
  return normalized;
}

/**
 * @param {Array<{name: string, data: string | Buffer | Uint8Array}>} entries
 * @param {Date} [now]
 * @returns {Buffer}
 */
export function createZip(entries, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeName(entry.name);
    const nameBuffer = Buffer.from(name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localChunks.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralChunks.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, ...centralChunks, end]);
}

/** Locate the end-of-central-directory record (last 64KB + 22 bytes). */
function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function inflate(data, method, name) {
  if (method === 0) return data;
  if (method === 8) {
    try {
      return inflateRawSync(data);
    } catch (error) {
      throw new Error(`Cannot inflate ZIP entry ${name}: ${error.message}`);
    }
  }
  throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
}

/**
 * Read a ZIP archive into memory. Supports STORE and DEFLATE entries, data
 * descriptors, and archives produced by Office, python-docx / python-pptx,
 * LibreOffice and the bundled writer.
 * @param {Buffer} buffer
 * @returns {Array<{name: string, data: Buffer}>}
 */
export function listZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error("Not a ZIP archive");
  }

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd >= 0) {
    const count = buffer.readUInt16LE(eocd + 10);
    const directorySize = buffer.readUInt32LE(eocd + 12);
    const directoryOffset = buffer.readUInt32LE(eocd + 16);
    if (count === 0xffff || directoryOffset === 0xffffffff) {
      throw new Error("ZIP64 archives are not supported");
    }
    if (directoryOffset + directorySize > buffer.length) {
      throw new Error("Truncated ZIP central directory");
    }

    const entries = [];
    let offset = directoryOffset;
    for (let index = 0; index < count; index += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
        throw new Error("Invalid ZIP central directory");
      }
      const flags = buffer.readUInt16LE(offset + 8);
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const extraLength = buffer.readUInt16LE(offset + 30);
      const commentLength = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.toString(
        flags & 0x0800 ? "utf8" : "latin1",
        offset + 46,
        offset + 46 + nameLength,
      );

      if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local header for ${name}`);
      }
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > buffer.length) throw new Error(`Truncated ZIP entry: ${name}`);

      entries.push({
        name,
        data: inflate(buffer.subarray(dataStart, dataEnd), method, name),
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }

    if (entries.length === 0) throw new Error("No ZIP entries found");
    return entries;
  }

  // Fallback: walk local headers (STORE / DEFLATE with known sizes).
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error("Invalid ZIP entry name");

    const name = buffer.toString(flags & 0x0800 ? "utf8" : "latin1", nameStart, nameEnd);
    if (flags & 0x0008) {
      throw new Error(`ZIP entry ${name} uses a data descriptor but no central directory was found`);
    }
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`Truncated ZIP entry: ${name}`);

    entries.push({ name, data: inflate(buffer.subarray(dataStart, dataEnd), method, name) });
    offset = dataEnd;
  }

  if (entries.length === 0) throw new Error("No ZIP entries found");
  return entries;
}
