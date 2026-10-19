import { rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { MirrorSpec } from "../registries.js";
import type { Row } from "./records.js";

/**
 * One SQLite file per registry: rows as JSON, an exact-match key table for
 * code columns, and a contentless FTS5 index over name-like columns.
 * node:sqlite is loaded lazily so stdio installs on Node 20 never touch it.
 */

export interface MirrorMeta {
  registry: string;
  dataset: string;
  resources: { id: string; name?: string; url: string; last_modified?: string | null }[];
  row_count: number;
  synced_at: string;
}

// getBuiltinModule (Node ≥22.3) keeps bundlers and test runners from trying
// to resolve node:sqlite, which several of them don't know yet.
async function sqlite(): Promise<typeof import("node:sqlite")> {
  const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!mod) throw new Error("lookup_record needs Node.js 22.5+ (node:sqlite)");
  return mod;
}

export const dbPath = (dir: string, key: string) => join(dir, `${key}.sqlite`);

/** Codes are matched case- and space-insensitively ("ab 123" = "AB123"). */
export const normalizeCode = (v: string) => v.replace(/[\s-]+/g, "").toUpperCase();

// Bounded so one huge free-text field can't bloat the index.
const MAX_INDEXED_CHARS = 2000;

export class MirrorWriter {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly tmpPath: string,
    private readonly finalPath: string,
    private readonly spec: MirrorSpec,
  ) {}

  private rows = 0;
  private missingWarned = false;
  private insertRow!: ReturnType<DatabaseSync["prepare"]>;
  private insertKey!: ReturnType<DatabaseSync["prepare"]>;
  private insertText!: ReturnType<DatabaseSync["prepare"]>;

  static async create(dir: string, key: string, spec: MirrorSpec): Promise<MirrorWriter> {
    const { DatabaseSync } = await sqlite();
    const finalPath = dbPath(dir, key);
    const tmpPath = `${finalPath}.tmp`;
    await rm(tmpPath, { force: true });
    const db = new DatabaseSync(tmpPath);
    db.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      CREATE TABLE records (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE keys (val TEXT NOT NULL, col TEXT NOT NULL, id INTEGER NOT NULL);
      CREATE VIRTUAL TABLE fts USING fts5(body, content='', tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      BEGIN;
    `);
    const w = new MirrorWriter(db, tmpPath, finalPath, spec);
    w.insertRow = db.prepare("INSERT INTO records (id, data) VALUES (?, ?)");
    w.insertKey = db.prepare("INSERT INTO keys (val, col, id) VALUES (?, ?, ?)");
    w.insertText = db.prepare("INSERT INTO fts (rowid, body) VALUES (?, ?)");
    return w;
  }

  add(row: Row): void {
    const id = ++this.rows;
    this.insertRow.run(id, JSON.stringify(row));
    for (const col of this.spec.exact) {
      const v = row[col];
      if (v) this.insertKey.run(normalizeCode(v), col, id);
    }
    // No text columns configured → index every value (unknown/changed schema).
    const textCols = this.spec.text.length ? this.spec.text : Object.keys(row);
    const body = textCols
      .map((c) => row[c] ?? "")
      .join(" ")
      .slice(0, MAX_INDEXED_CHARS);
    if (body.trim()) this.insertText.run(id, body);
    if (id % 100_000 === 0) this.db.exec("COMMIT; BEGIN;");
  }

  /** Configured columns absent from the data — the portal changed its export. */
  missingColumns(row: Row): string[] {
    if (this.missingWarned) return [];
    this.missingWarned = true;
    return [...this.spec.exact, ...this.spec.text].filter((c) => !(c in row));
  }

  get count(): number {
    return this.rows;
  }

  /** Index, record metadata and atomically replace the live database. */
  async commit(meta: MirrorMeta): Promise<void> {
    this.db.exec("COMMIT;");
    this.db.exec("CREATE INDEX keys_val ON keys (val);");
    this.db.exec("INSERT INTO fts(fts) VALUES ('optimize');");
    this.db.prepare("INSERT INTO meta (k, v) VALUES ('meta', ?)").run(JSON.stringify(meta));
    this.db.close();
    await rename(this.tmpPath, this.finalPath);
  }

  async abort(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // already closed
    }
    await rm(this.tmpPath, { force: true });
  }
}

export interface LookupResult {
  match: "exact" | "text";
  rows: Row[];
  more: boolean;
}

/** Read side, shared by all requests; reopens when sync swapped the file. */
export class MirrorReader {
  private handles = new Map<string, { db: DatabaseSync; mtimeMs: number }>();

  constructor(private readonly dir: string) {}

  private async open(key: string): Promise<DatabaseSync | undefined> {
    const path = dbPath(this.dir, key);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      return undefined;
    }
    const cached = this.handles.get(key);
    if (cached && cached.mtimeMs === mtimeMs) return cached.db;
    cached?.db.close();
    const { DatabaseSync } = await sqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    this.handles.set(key, { db, mtimeMs });
    return db;
  }

  async meta(key: string): Promise<MirrorMeta | undefined> {
    const db = await this.open(key);
    const row = db?.prepare("SELECT v FROM meta WHERE k = 'meta'").get() as
      | { v: string }
      | undefined;
    return row ? (JSON.parse(row.v) as MirrorMeta) : undefined;
  }

  async lookup(key: string, query: string, limit: number): Promise<LookupResult | undefined> {
    const db = await this.open(key);
    if (!db) return undefined;
    const parse = (rows: unknown[]) =>
      rows.map((r) => JSON.parse((r as { data: string }).data) as Row);

    const code = normalizeCode(query);
    if (/^[\p{L}\p{N}/.]+$/u.test(code) && /\d/.test(code)) {
      const rows = db
        .prepare("SELECT r.data FROM keys k JOIN records r ON r.id = k.id WHERE k.val = ? LIMIT ?")
        .all(code, limit + 1);
      if (rows.length)
        return { match: "exact", rows: parse(rows.slice(0, limit)), more: rows.length > limit };
    }

    const match = ftsQuery(query);
    if (!match) return { match: "text", rows: [], more: false };
    const rows = db
      .prepare(
        "SELECT r.data FROM fts JOIN records r ON r.id = fts.rowid WHERE fts MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(match, limit + 1);
    return { match: "text", rows: parse(rows.slice(0, limit)), more: rows.length > limit };
  }

  close(): void {
    for (const { db } of this.handles.values()) db.close();
    this.handles.clear();
  }
}

/** Every word must match, as a prefix ("ромаш" finds "Ромашка"). */
export function ftsQuery(query: string): string | undefined {
  const words = query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return undefined;
  return words.map((w) => `"${w}"*`).join(" ");
}
