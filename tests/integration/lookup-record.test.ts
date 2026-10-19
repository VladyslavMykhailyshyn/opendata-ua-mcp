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
import { createLogger } from "../../src/util/logger.js";

const BASE = "https://data.gov.ua/api/3/action";
const FILE = "https://data.gov.ua/dataset/x/resource/uo/download/uo.zip";
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
let downloads = 0;
const portal = setupServer(
  http.get(`${BASE}/package_show`, () =>
    HttpResponse.json({
      success: true,
      result: {
        id: "pkg",
        name: edr.dataset,
        resources: [
          { id: "fop", name: "FOP.zip", format: "ZIP", url: FILE.replace("uo.zip", "fop.zip") },
          { id: "uo", name: "UO.zip", format: "ZIP", url: FILE, last_modified: lastModified },
        ],
      },
    }),
  ),
  http.get(FILE, () => {
    downloads++;
    return new HttpResponse(zipBuf, { headers: { "content-type": "application/zip" } });
  }),
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

    const notSynced = await call({ registry: "vehicles", query: "WBA123" });
    expect(notSynced.error).toContain("ще не синхронізовано");
    await client.close();
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
