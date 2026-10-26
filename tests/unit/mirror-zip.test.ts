import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { listZipEntries, openZipEntry } from "../../src/mirror/zip-stream.js";

/**
 * The ZIP comes from the network: every offset in it is attacker-controlled.
 * These tests prove the reader throws (never hangs, never allocates by a
 * length it read from the file) on corrupt and fuzzed directories.
 */

let dir: string;
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mirror-zipfuzz-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(buf: Buffer): Promise<string> {
  const path = join(dir, `${n++}.zip`);
  await writeFile(path, buf);
  return path;
}

/** Resolve to the outcome, or fail if listing takes longer than a second. */
async function listOutcome(buf: Buffer): Promise<"ok" | "error"> {
  const path = await file(buf);
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("listZipEntries hung")), 1000).unref(),
  );
  return Promise.race([listZipEntries(path, buf.length), timer]).then(
    () => "ok" as const,
    (err: Error) => {
      if (err.message === "listZipEntries hung") throw err;
      return "error" as const;
    },
  );
}

function validZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("schema.xsd", Buffer.from("<x/>"));
  zip.addFile("data.csv", Buffer.from("VIN;BRAND\n" + "ABC123;BMW\n".repeat(2000)));
  return zip.toBuffer();
}

/** adm-zip writes no archive comment, so the EOCD record is the last 22 bytes. */
const eocdAt = (buf: Buffer) => buf.length - 22;

describe("ZIP central directory bounds", () => {
  it("reads a valid archive (control)", async () => {
    const buf = validZip();
    const entries = await listZipEntries(await file(buf), buf.length);
    expect(entries.map((e) => e.name).sort()).toEqual(["data.csv", "schema.xsd"]);
    expect(entries.every((e) => !e.encrypted)).toBe(true);
  });

  it("rejects a truncated end of central directory", async () => {
    const buf = validZip();
    expect(await listOutcome(buf.subarray(0, buf.length - 5))).toBe("error");
    expect(await listOutcome(buf.subarray(0, 10))).toBe("error");
    expect(await listOutcome(Buffer.alloc(0))).toBe("error");
  });

  it("rejects cdSize = 0xFFFFFFFF before allocating anything", async () => {
    const buf = validZip();
    buf.writeUInt32LE(0xffffffff, eocdAt(buf) + 12);
    const path = await file(buf);
    await expect(listZipEntries(path, buf.length)).rejects.toThrow(/central directory of/);
  });

  it("rejects a central directory that runs past the end of the file", async () => {
    const buf = validZip();
    buf.writeUInt32LE(buf.length - 10, eocdAt(buf) + 16);
    const path = await file(buf);
    await expect(listZipEntries(path, buf.length)).rejects.toThrow(/beyond end of file/);
  });

  it("rejects an entry count larger than the directory holds without spinning", async () => {
    const buf = validZip();
    buf.writeUInt16LE(0xffff, eocdAt(buf) + 10);
    const path = await file(buf);
    // Loop is bounded by the directory bytes, so it just stops after the real entries.
    expect((await listZipEntries(path, buf.length)).length).toBe(2);
  });

  it("rejects a local header offset beyond the file", async () => {
    const buf = validZip();
    const cdOffset = buf.readUInt32LE(eocdAt(buf) + 16);
    buf.writeUInt32LE(buf.length - 3, cdOffset + 42);
    const path = await file(buf);
    await expect(listZipEntries(path, buf.length)).rejects.toThrow(/local header offset/);
  });

  it("rejects an entry whose data runs past the file at open time", async () => {
    const buf = validZip();
    const path = await file(buf);
    const [entry] = await listZipEntries(path, buf.length);
    await expect(openZipEntry(path, { ...entry!, compressedSize: buf.length })).rejects.toThrow(
      /truncated/,
    );
    await expect(
      openZipEntry(path, { ...entry!, localHeaderOffset: buf.length - 1 }),
    ).rejects.toThrow(/corrupt ZIP/);
  });

  it("refuses encrypted entries", async () => {
    const buf = validZip();
    const cdOffset = buf.readUInt32LE(eocdAt(buf) + 16);
    buf.writeUInt16LE(buf.readUInt16LE(cdOffset + 8) | 1, cdOffset + 8);
    const path = await file(buf);
    const entries = await listZipEntries(path, buf.length);
    const enc = entries.find((e) => e.encrypted)!;
    expect(enc).toBeDefined();
    await expect(openZipEntry(path, enc)).rejects.toThrow(/encrypted/);
  });

  it("stops inflating past the byte cap", async () => {
    const buf = validZip();
    const path = await file(buf);
    const csv = (await listZipEntries(path, buf.length)).find((e) => e.name === "data.csv")!;
    const stream = await openZipEntry(path, csv, 1000);
    const drain = async () => {
      for await (const _chunk of stream) {
        // consume
      }
    };
    await expect(drain()).rejects.toThrow(/inflates past 1000 bytes/);
  });

  it("never hangs on fuzzed input", async () => {
    const buf = validZip();
    const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const LOCATOR_SIG = Buffer.from([0x50, 0x4b, 0x06, 0x07]);
    for (let i = 0; i < 150; i++) {
      // Random bytes, random bytes with an EOCD signature planted, and
      // mutated copies of a real archive.
      const kind = i % 3;
      let fuzz: Buffer;
      if (kind === 0) {
        fuzz = randomBytes(Math.floor(Math.random() * 3000));
      } else if (kind === 1) {
        fuzz = randomBytes(64 + Math.floor(Math.random() * 3000));
        EOCD_SIG.copy(fuzz, fuzz.length - 22);
        if (i % 2) LOCATOR_SIG.copy(fuzz, fuzz.length - 42);
      } else {
        fuzz = Buffer.from(buf);
        for (let k = 0; k < 8; k++) {
          fuzz[Math.floor(Math.random() * fuzz.length)] = Math.floor(Math.random() * 256);
        }
        // Keep the EOCD findable so the directory walk is what gets fuzzed.
        EOCD_SIG.copy(fuzz, eocdAt(fuzz));
      }
      await listOutcome(fuzz); // throws only if it hung
    }
  }, 30_000);
});
