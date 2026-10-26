import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { MirrorReader, MirrorWriter, type MirrorMeta } from "../../src/mirror/store.js";

/**
 * sync.js replaces a registry's database with rename(2) while the server
 * holds the old one open. The reader must notice the swap by inode, because
 * a rebuilt file can carry the same mtime (coarse timestamps, same second).
 *
 * Windows refuses to rename over an open file, so the inode case is driven
 * through a stat stub; the real rename runs where the platform allows it.
 */

const statStub = vi.hoisted(() => ({ patch: undefined as undefined | ((s: Stats) => Stats) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const s = (await actual.stat(...args)) as Stats;
      return statStub.patch ? statStub.patch(s) : s;
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mirror-swap-"));
});
afterEach(async () => {
  statStub.patch = undefined;
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

const meta = (row_count: number): MirrorMeta => ({
  registry: "t",
  dataset: "d",
  resources: [],
  row_count,
  synced_at: "now",
});

async function build(key: string, name: string): Promise<void> {
  const w = await MirrorWriter.create(dir, key, { format: "csv", exact: [], text: ["NAME"] });
  w.add({ NAME: name });
  await w.commit(meta(1));
}

const handle = (reader: MirrorReader, key: string) =>
  (reader as unknown as { handles: Map<string, { db: DatabaseSync }> }).handles.get(key)!.db;

describe("MirrorReader handle cache", () => {
  it("reopens when the inode changes even if mtime is identical, closing the old handle", async () => {
    await build("t", "Ромашка");
    const reader = new MirrorReader(dir);
    expect((await reader.lookup("t", "ромашка", 1))!.rows).toEqual([{ NAME: "Ромашка" }]);
    const first = handle(reader, "t");
    expect(await reader.lookup("t", "ромашка", 1)).toBeDefined();
    expect(handle(reader, "t") === first).toBe(true); // unchanged: cached

    statStub.patch = (s) =>
      Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: s.ino + 1 });
    expect((await reader.lookup("t", "ромашка", 1))!.rows).toEqual([{ NAME: "Ромашка" }]);
    // Matchers must not inspect the closed handle (its getters throw).
    expect(handle(reader, "t") === first).toBe(false);
    expect(() => first.prepare("SELECT 1")).toThrow(/not open/);
    reader.close();
  });

  it.skipIf(process.platform === "win32")("serves the new file after a rename-over", async () => {
    await build("t", "Стара");
    const reader = new MirrorReader(dir);
    expect((await reader.lookup("t", "стара", 1))!.rows).toEqual([{ NAME: "Стара" }]);
    await build("t-new", "Нова");
    await rename(join(dir, "t-new.sqlite"), join(dir, "t.sqlite"));
    expect((await reader.lookup("t", "нова", 1))!.rows).toEqual([{ NAME: "Нова" }]);
    expect((await reader.lookup("t", "стара", 1))!.rows).toEqual([]);
    reader.close();
  });
});
