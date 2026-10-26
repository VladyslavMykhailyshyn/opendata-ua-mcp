import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CkanClient } from "../../src/ckan/client.js";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";
import { MIRRORED } from "../../src/registries.js";
import { syncRegistry } from "../../src/mirror/sync.js";
import { MirrorReader, MirrorWriter } from "../../src/mirror/store.js";
import { createLogger } from "../../src/util/logger.js";

const BASE = "https://data.gov.ua/api/3/action";
const FILE = "https://data.gov.ua/dataset/x/resource/uo/download/uo.zip";
// The mirror spec matches on `uo.zip$`, so the variants differ in path only.
const REDIRECT = "https://data.gov.ua/dataset/x/resource/uo/redirect/uo.zip";
const LOOP = "https://data.gov.ua/dataset/x/resource/uo/loop/uo.zip";
const OFFHOST_HOP = "https://data.gov.ua/dataset/x/resource/uo/cdnhop/uo.zip";
const edr = MIRRORED.find((r) => r.key === "edr-uo")!;

function cp1251(s: string): Buffer {
  // Enough of Windows-1251 for the test strings.
  const map: Record<string, number> = {
    Т: 0xd2,
    О: 0xce,
    В: 0xc2,
    Р: 0xd0,
    М: 0xcc,
    А: 0xc0,
    Ш: 0xd8,
    К: 0xca,
  };
  return Buffer.from([...s].map((ch) => map[ch] ?? ch.charCodeAt(0)));
}

const xml =
  '<?xml version="1.0" encoding="windows-1251"?>\n<DATA>' +
  "<SUBJECT><NAME>ТОВ РОМАШКА</NAME><SHORT_NAME>РОМАШКА</SHORT_NAME><EDRPOU>01234567</EDRPOU><STAN>зареєстровано</STAN></SUBJECT>\n" +
  "<SUBJECT><NAME>ТОВ ВАТРА</NAME><EDRPOU>76543210</EDRPOU></SUBJECT>\n</DATA>";
const zip = new AdmZip();
zip.addFile("UO.xml", Buffer.concat([cp1251(xml.replace("зареєстровано", "OK"))]));
const zipBuf = zip.toBuffer();

let lastModified = "2026-10-13T00:00:00";
let resourceUrl = FILE;
let downloads = 0;
const redirect = (to: string) => new HttpResponse(null, { status: 302, headers: { location: to } });
const portal = setupServer(
  http.get(`${BASE}/package_show`, () =>
    HttpResponse.json({
      success: true,
      result: {
        id: "pkg",
        name: edr.dataset,
        resources: [
          { id: "fop", name: "FOP.zip", format: "ZIP", url: FILE.replace("uo.zip", "fop.zip") },
          {
            id: "uo",
            name: "UO.zip",
            format: "ZIP",
            url: resourceUrl,
            last_modified: lastModified,
          },
        ],
      },
    }),
  ),
  http.get(FILE, () => {
    downloads++;
    return new HttpResponse(zipBuf, { headers: { "content-type": "application/zip" } });
  }),
  http.get(REDIRECT, () => redirect("../download/uo.zip")), // relative Location
  http.get(LOOP, () => redirect(LOOP)),
  http.get(OFFHOST_HOP, () => redirect("https://cdn.example.com/uo.zip")),
);

let dir: string;
const log = createLogger({ logLevel: "error" });

beforeAll(async () => {
  portal.listen({ onUnhandledRequest: "error" });
  dir = await mkdtemp(join(tmpdir(), "mirror-e2e-"));
});
afterAll(async () => {
  portal.close();
  // The tool keeps its read handle open for the server's lifetime; Windows
  // refuses to delete an open file, Linux doesn't care.
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("registry mirror end-to-end", () => {
  it("syncs, skips unchanged resources, and serves lookup_record over MCP", async () => {
    const config = loadConfig({ MIRROR_DIR: dir } as NodeJS.ProcessEnv);
    const ckan = new CkanClient(config, log);
    const opts = { dir, userAgent: "test" };

    expect(await syncRegistry(edr, ckan, log, opts)).toMatchObject({ status: "synced", rows: 2 });
    expect(await syncRegistry(edr, ckan, log, opts)).toEqual({ status: "unchanged" });
    expect(downloads).toBe(1);
    lastModified = "2026-10-20T00:00:00";
    expect(await syncRegistry(edr, ckan, log, opts)).toMatchObject({ status: "synced" });
    expect(downloads).toBe(2);

    const server = createServer({ config, log, ckan });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("lookup_record");

    const call = async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: "lookup_record", arguments: args });
      return JSON.parse((res.content as { text: string }[])[0]!.text);
    };
    const byCode = await call({ registry: "edr-uo", query: "01234567" });
    expect(byCode.match).toBe("exact");
    expect(byCode.results).toEqual([
      { NAME: "ТОВ РОМАШКА", SHORT_NAME: "РОМАШКА", EDRPOU: "01234567", STAN: "OK" },
    ]);
    expect(byCode.snapshot.source_updated).toBe("2026-10-20T00:00:00");

    const byName = await call({ registry: "edr-uo", query: "ватра" });
    expect(byName.match).toBe("text");
    expect(byName.results[0].EDRPOU).toBe("76543210");
    expect(byName).toMatchObject({ count: 1, returned: 1, more: false });
    expect(byName.next_offset).toBeUndefined();

    // Two rows match "ТОВ", limit 1: honest count, more, and a hint to narrow.
    const capped = await call({ registry: "edr-uo", query: "тов", limit: 1 });
    expect(capped).toMatchObject({ count: 1, returned: 1, more: true });
    expect(capped.note).toContain("уточни запит");
    expect(capped.next_offset).toBeUndefined();

    // Nothing to anchor an index scan on: refused before touching SQLite.
    const short = await call({ registry: "edr-uo", query: "пп" });
    expect(short.error).toContain("занадто короткий");
    // A short code is still an exact lookup, just an empty one.
    expect(await call({ registry: "edr-uo", query: "12" })).toMatchObject({ results: [] });

    const notSynced = await call({ registry: "vehicles", query: "WBA123" });
    expect(notSynced.error).toContain("ще не синхронізовано");
    await client.close();
  });

  describe("sync hardening", () => {
    let hdir: string;
    let ckan: CkanClient;
    const WEEK = 7 * 24 * 3600 * 1000;
    beforeAll(async () => {
      hdir = await mkdtemp(join(tmpdir(), "mirror-hard-"));
      ckan = new CkanClient(loadConfig({ MIRROR_DIR: hdir } as NodeJS.ProcessEnv), log);
    });
    afterAll(async () => {
      resourceUrl = FILE;
      await rm(hdir, { recursive: true, force: true }).catch(() => undefined);
    });
    const opts = () => ({ dir: hdir, userAgent: "test" });

    /** A copy that already matches the portal's resource but is `ageMs` old. */
    async function prebuild(rows: number, ageMs: number): Promise<void> {
      const w = await MirrorWriter.create(hdir, edr.key, edr.mirror);
      for (let i = 0; i < rows; i++) w.add({ NAME: `ТОВ ${i}`, EDRPOU: String(10000000 + i) });
      await w.commit({
        registry: edr.key,
        dataset: edr.dataset,
        resources: [{ id: "uo", name: "UO.zip", url: FILE, last_modified: lastModified }],
        row_count: rows,
        synced_at: new Date(Date.now() - ageMs).toISOString(),
      });
    }

    it("re-syncs a matching resource once the copy is a week old", async () => {
      await prebuild(2, 1000);
      expect(await syncRegistry(edr, ckan, log, opts())).toEqual({ status: "unchanged" });
      await prebuild(2, WEEK + 1000);
      const before = downloads;
      expect(await syncRegistry(edr, ckan, log, opts())).toMatchObject({ status: "synced" });
      expect(downloads).toBe(before + 1);
    });

    it("keeps the old copy when the new export lost more than 20% of its rows", async () => {
      await prebuild(10, WEEK + 1000);
      await expect(syncRegistry(edr, ckan, log, opts())).rejects.toThrow(
        /only 2 rows parsed, previous sync had 10/,
      );
      const reader = new MirrorReader(hdir);
      expect((await reader.meta(edr.key))!.row_count).toBe(10);
      reader.close();
      expect(await syncRegistry(edr, ckan, log, { ...opts(), force: true })).toMatchObject({
        status: "synced",
        rows: 2,
      });
    });

    it("fails when a required column never appears in the data", async () => {
      const def = { ...edr, mirror: { ...edr.mirror, exact: ["NOPE"] } };
      await expect(syncRegistry(def, ckan, log, { ...opts(), force: true })).rejects.toThrow(
        /columns NOPE not in the first 2 rows/,
      );
    });

    it("follows same-host redirects and refuses loops and off-host hops", async () => {
      resourceUrl = REDIRECT;
      const before = downloads;
      expect(await syncRegistry(edr, ckan, log, { ...opts(), force: true })).toMatchObject({
        status: "synced",
      });
      expect(downloads).toBe(before + 1);

      resourceUrl = LOOP;
      await expect(syncRegistry(edr, ckan, log, { ...opts(), force: true })).rejects.toThrow(
        /more than 5 redirects/,
      );
      resourceUrl = OFFHOST_HOP;
      await expect(syncRegistry(edr, ckan, log, { ...opts(), force: true })).rejects.toThrow(
        /download refused: https:\/\/cdn\.example\.com/,
      );
      resourceUrl = "https://cdn.example.com/uo.zip";
      await expect(syncRegistry(edr, ckan, log, { ...opts(), force: true })).rejects.toThrow(
        /download refused/,
      );
      resourceUrl = "http://data.gov.ua/dataset/x/resource/uo/download/uo.zip";
      await expect(syncRegistry(edr, ckan, log, { ...opts(), force: true })).rejects.toThrow(
        /download refused: http:/,
      );
      expect(downloads).toBe(before + 1);
    });

    it("stops at the abort signal and leaves no tmp files", async () => {
      resourceUrl = FILE;
      const ac = new AbortController();
      ac.abort(new Error("SIGTERM"));
      await expect(
        syncRegistry(edr, ckan, log, { ...opts(), force: true, signal: ac.signal }),
      ).rejects.toThrow();
      const { readdir } = await import("node:fs/promises");
      const left = (await readdir(hdir)).filter((f) => /\.(tmp|download)$/.test(f));
      expect(left).toEqual([]);
    });
  });

  it("hides lookup_record when no mirror is configured", async () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    const server = createServer({ config, log });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("lookup_record");
    await client.close();
  });
});
