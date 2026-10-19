import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";

/**
 * Minimal streaming ZIP reader for files on disk. adm-zip loads whole entries
 * into memory, but ЄДР ships a 3 GB XML inside a 330 MB ZIP. Reads the
 * central directory (with ZIP64), then streams one entry through inflate.
 */

export interface ZipEntryInfo {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_U32 = 0xffffffff;

async function readAt(path: string, position: number, length: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function listZipEntries(path: string, fileSize: number): Promise<ZipEntryInfo[]> {
  // EOCD is in the last 22 bytes + up to 64 KB of comment.
  const tailLen = Math.min(fileSize, 22 + 0xffff + 20);
  const tail = await readAt(path, fileSize - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end of central directory)");

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === EOCD64_LOCATOR) {
    const eocd64Offset = Number(tail.readBigUInt64LE(eocd - 20 + 8));
    const rec = await readAt(path, eocd64Offset, 56);
    if (rec.readUInt32LE(0) === EOCD64) {
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
  }

  const cd = await readAt(path, cdOffset, cdSize);
  const entries: ZipEntryInfo[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== CENTRAL) throw new Error("corrupt ZIP central directory");
    const method = cd.readUInt16LE(p + 10);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);

    // ZIP64 extra field (id 0x0001) carries the real values of fields set to 0xFFFFFFFF.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const next = () => {
          const v = Number(cd.readBigUInt64LE(q));
          q += 8;
          return v;
        };
        if (size === MAX_U32) size = next();
        if (compressedSize === MAX_U32) compressedSize = next();
        if (localHeaderOffset === MAX_U32) localHeaderOffset = next();
      }
      e += 4 + len;
    }

    if (!name.endsWith("/"))
      entries.push({ name, method, compressedSize, size, localHeaderOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

export async function openZipEntry(path: string, entry: ZipEntryInfo): Promise<Readable> {
  const header = await readAt(path, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL) throw new Error(`corrupt local header for ${entry.name}`);
  // Local name/extra lengths can differ from the central directory's.
  const dataStart =
    entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (entry.compressedSize === 0) return Readable.from([]);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`unsupported ZIP compression method ${entry.method}`);
  }
  const raw = createReadStream(path, {
    start: dataStart,
    end: dataStart + entry.compressedSize - 1,
  });
  if (entry.method === 0) return raw;
  const inflate = createInflateRaw();
  raw.on("error", (err) => inflate.destroy(err));
  return raw.pipe(inflate);
}
