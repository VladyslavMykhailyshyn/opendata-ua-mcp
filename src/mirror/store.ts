import { open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Marks a directory as ours, so pruning never runs in a misconfigured MIRROR_DIR. */
export const SENTINEL = ".opendata-mirror";

// getBuiltinModule (Node ≥22.3) keeps bundlers and test runners from trying
// to resolve node:sqlite, which several of them don't know yet.
async function sqlite(): Promise<typeof import("node:sqlite")> {
  const mod = process.getBuiltinModule?.("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (!mod) throw new Error("lookup_record needs Node.js 22.5+ (node:sqlite)");
  return mod;
}

/** `DatabaseSync({ readOnly })` arrived in 22.12; older builds silently open read-write. */
export function assertSqliteNode(version: string): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) return;
  throw new Error(`lookup_record needs Node.js 22.12+ for read-only node:sqlite, got ${version}`);
}

export const dbPath = (dir: string, key: string) => join(dir, `${key}.sqlite`);

export async function touchSentinel(dir: string): Promise<void> {
  await writeFile(join(dir, SENTINEL), "", { flag: "a" });
}

/** Codes are matched case- and space-insensitively ("ab 123" = "AB123"). */
export const normalizeCode = (v: string) => v.replace(/[\s-]+/g, "").toUpperCase();

/** A query that may be a registry code: letters/digits with at least one digit. */
export const isCodeQuery = (query: string) => {
  const code = normalizeCode(query);
  return /^[\p{L}\p{N}/.]+$/u.test(code) && /\d/.test(code);
};

// Bounded so one huge free-text field can't bloat the index.
const MAX_INDEXED_CHARS = 2000;
// Some ЄДР records list thousands of founders/branches (one is 1.1 MB).
const MAX_STORED_CHARS = 2000;
// Rows whose column names are checked against the spec (sparse columns may be
// empty in the first record).
const COLUMN_SAMPLE_ROWS = 1000;
// Text matches are ranked within this many candidates: ranking every hit of a
// common word over 7M ФОП rows would block the (synchronous) server for seconds.
const FTS_CANDIDATES = 5000;

export class MirrorWriter {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly tmpPath: string,
    private readonly finalPath: string,
    private readonly spec: MirrorSpec,
  ) {}

  private rows = 0;
  private readonly seenColumns = new Set<string>();
  private insertRow!: ReturnType<DatabaseSync["prepare"]>;
  private insertKey!: ReturnType<DatabaseSync["prepare"]>;
  private insertText!: ReturnType<DatabaseSync["prepare"]>;

  static async create(dir: string, key: string, spec: MirrorSpec): Promise<MirrorWriter> {
    const { DatabaseSync } = await sqlite();
    const finalPath = dbPath(dir, key);
    const tmpPath = `${finalPath}.tmp`;
    await rm(tmpPath, { force: true });
    await touchSentinel(dir);
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

  add(input: Row): void {
    const row = this.spec.transform ? transformRow(input, this.spec.transform) : input;
    const id = ++this.rows;
    if (id <= COLUMN_SAMPLE_ROWS) for (const c of Object.keys(row)) this.seenColumns.add(c);
    this.insertRow.run(id, JSON.stringify(this.stored(row)));
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

  /** Only the columns an answer needs, each bounded in length. */
  private stored(row: Row): Row {
    const { keep, exact, text } = this.spec;
    const cols = keep ? [...exact, ...text, ...keep] : Object.keys(row);
    const out: Row = {};
    for (const c of cols) {
      const v = row[c];
      if (v) out[c] = v.length > MAX_STORED_CHARS ? v.slice(0, MAX_STORED_CHARS) + "…" : v;
    }
    return out;
  }

  /**
   * Configured columns that never appeared in the first 1000 rows — the portal
   * changed its export. `required` (exact/text) breaks lookups; `kept` only
   * loses an answer column.
   */
  missingColumns(): { required: string[]; kept: string[] } {
    const absent = (cols: string[]) => cols.filter((c) => !this.seenColumns.has(c));
    return {
      required: absent([...this.spec.exact, ...this.spec.text]),
      kept: absent(this.spec.keep ?? []),
    };
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
    // synchronous=OFF above: the data must reach the disk before the rename
    // makes it the live copy, or a crash leaves a truncated "good" file.
    await fsync(this.tmpPath, "r+"); // Windows needs write access to flush
    await rename(this.tmpPath, this.finalPath);
    await fsync(dirname(this.finalPath), "r").catch(() => undefined); // Windows: EISDIR
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

async function fsync(path: string, flags: "r" | "r+"): Promise<void> {
  const fh = await open(path, flags);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function transformRow(row: Row, transform: NonNullable<MirrorSpec["transform"]>): Row {
  const out = { ...row };
  for (const [col, fn] of Object.entries(transform)) {
    const v = out[col];
    if (v !== undefined) out[col] = fn(v);
  }
  return out;
}

export interface LookupResult {
  match: "exact" | "text";
  rows: Row[];
  more: boolean;
  /** Query wall-clock time; the caller logs slow ones. */
  ms: number;
}

/** Read side, shared by all requests; reopens when sync swapped the file. */
export class MirrorReader {
  private handles = new Map<string, { db: DatabaseSync; mtimeMs: number; ino: number }>();

  constructor(private readonly dir: string) {
    assertSqliteNode(process.versions.node);
  }

  private async open(key: string): Promise<DatabaseSync | undefined> {
    const path = dbPath(this.dir, key);
    let mtimeMs: number;
    let ino: number;
    try {
      ({ mtimeMs, ino } = await stat(path));
    } catch {
      return undefined;
    }
    const cached = this.handles.get(key);
    // The inode changes on every rename-over; mtime alone can repeat.
    if (cached && cached.mtimeMs === mtimeMs && cached.ino === ino) return cached.db;
    const { DatabaseSync } = await sqlite();
    const db = new DatabaseSync(path, { readOnly: true });
    this.handles.set(key, { db, mtimeMs, ino });
    cached?.db.close();
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
    const started = performance.now();
    const result = (match: LookupResult["match"], rows: unknown[]): LookupResult => ({
      match,
      rows: rows.slice(0, limit).map((r) => JSON.parse((r as { data: string }).data) as Row),
      more: rows.length > limit,
      ms: Math.round(performance.now() - started),
    });

    if (isCodeQuery(query)) {
      const rows = db
        .prepare("SELECT r.data FROM keys k JOIN records r ON r.id = k.id WHERE k.val = ? LIMIT ?")
        .all(normalizeCode(query), limit + 1);
      if (rows.length) return result("exact", rows);
    }

    const match = ftsQuery(query);
    if (!match) return result("text", []);
    const rows = db
      .prepare(
        `WITH c AS (SELECT rowid, rank FROM fts WHERE fts MATCH ? LIMIT ${FTS_CANDIDATES})
         SELECT r.data FROM c JOIN records r ON r.id = c.rowid ORDER BY c.rank LIMIT ?`,
      )
      .all(match, limit + 1);
    return result("text", rows);
  }

  close(): void {
    for (const { db } of this.handles.values()) db.close();
    this.handles.clear();
  }
}

const MAX_TERMS = 6;
const MIN_PREFIX_CHARS = 3;

/**
 * Every word must match: words of 3+ characters as a prefix ("ромаш" finds
 * "Ромашка"), shorter ones exactly ("пп"* would walk every word starting with
 * those letters). Undefined when no word is long enough to anchor a scan.
 */
export function ftsQuery(query: string): string | undefined {
  const words = (query.normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS);
  const isPrefix = (w: string) => [...w].length >= MIN_PREFIX_CHARS;
  if (!words.some(isPrefix)) return undefined;
  return words.map((w) => (isPrefix(w) ? `"${w}"*` : `"${w}"`)).join(" ");
}
