import * as fs from "fs";
import * as path from "path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";
import { IStructuredAdapter } from "./IStructuredAdapter";
import { KnowledgeGraph, Entity, Relation, Observation } from "../../types";
import { Logger } from "../../shared";

/**
 * SQLite structured-emit adapter (data-sink track, Class A). A `.db` is a property
 * graph in disguise: this maps it DIRECTLY to graph fragments — **no LLM, no
 * hallucination** — tables → entity types, rows → entities, foreign keys → edges.
 * The fragment still flows through merge/canon, so a SQLite `Author` reconciles
 * with a prose-extracted `author`. Every fact is stamped `sourceAdapter:"sqlite"`
 * + `locator:"table:<t>/row:<pk>"` (ECS source-tagging).
 *
 * Uses `sql.js` (WASM) — zero native build, runs on the Node-18 baseline. The
 * `IStructuredAdapter` boundary makes a later swap to the built-in `node:sqlite`
 * (once it stabilizes) a one-file change. Read-only introspection; the whole file
 * is loaded into memory (a sql.js trait) — fine for a batch tool, bounded on output
 * by `maxRowsPerTable`.
 */
export interface SqliteAdapterOptions {
  extensions: string[];
  maxRowsPerTable: number;
  excludeTables: string[];
}

interface ColInfo {
  name: string;
  type: string;
  pk: boolean;
}
interface FkInfo {
  from: string; // child column
  table: string; // parent table
  to: string; // parent column referenced
}

const SQLITE_MAGIC = "SQLite format 3"; // 16-byte magic
const LABEL_COLS = ["name", "title", "label", "slug"];

let sqlJsPromise: Promise<SqlJsStatic> | undefined;
function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    // sql-wasm.wasm ships beside the resolved dist entry — point sql.js at it.
    const dist = path.dirname(require.resolve("sql.js"));
    sqlJsPromise = initSqlJs({ locateFile: (f) => path.join(dist, f) });
  }
  return sqlJsPromise;
}

export class SqliteAdapter implements IStructuredAdapter {
  readonly id = "sqlite";

  constructor(private readonly opts: SqliteAdapterOptions, private readonly logger: Logger) {}

  canHandle(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (!this.opts.extensions.map((e) => e.toLowerCase()).includes(ext)) return false;
    return this.hasSqliteHeader(filePath); // a non-sqlite `.db` falls through to the normal path
  }

  private hasSqliteHeader(filePath: string): boolean {
    try {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(16);
        fs.readSync(fd, buf, 0, 16, 0);
        return buf.toString("latin1", 0, 15) === SQLITE_MAGIC;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  async extract(filePath: string): Promise<KnowledgeGraph | null> {
    const SQL = await getSqlJs();
    let db: Database;
    try {
      db = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)));
    } catch (err) {
      this.logger.warn(`SQLite adapter could not open ${filePath} (${err}); skipping.`);
      return null;
    }
    try {
      return this.mapDatabase(db, filePath);
    } finally {
      db.close();
    }
  }

  private mapDatabase(db: Database, filePath: string): KnowledgeGraph | null {
    const tables = this.userTables(db).filter((t) => !this.opts.excludeTables.includes(t));
    if (tables.length === 0) return null;

    // Schema per table + which columns are referenced as FK targets (so we can index them).
    const schema = new Map<string, { cols: ColInfo[]; pk: string | null; fks: FkInfo[] }>();
    const referencedCols = new Map<string, Set<string>>();
    for (const t of tables) {
      const cols = this.tableInfo(db, t);
      const fks = this.fkList(db, t);
      schema.set(t, { cols, pk: cols.find((c) => c.pk)?.name ?? null, fks });
    }
    for (const { fks } of schema.values()) {
      for (const fk of fks) {
        if (!referencedCols.has(fk.table)) referencedCols.set(fk.table, new Set());
        referencedCols.get(fk.table)!.add(fk.to);
      }
    }

    const entities: Entity[] = [];
    const relations: Relation[] = [];
    // `${table}␟${col}` → (cell value → entity name), for resolving FK targets in pass 2.
    const index = new Map<string, Map<string, string>>();
    // Cache the (possibly capped) rows + their computed entity names per table for pass 2.
    const rowsByTable = new Map<string, { rows: Record<string, unknown>[]; names: string[] }>();

    // ── pass 1: rows → entities (+ observations), build the FK-target index ──
    for (const t of tables) {
      const { cols, pk, fks } = schema.get(t)!;
      const fkFrom = new Set(fks.map((f) => f.from));
      const labelCol = this.pickLabelCol(cols);
      const rows = this.selectRows(db, t);
      const names: string[] = [];
      const idxCols = new Set<string>([...(pk ? [pk] : []), ...(referencedCols.get(t) ?? [])]);

      rows.forEach((row, i) => {
        const pkVal = pk != null && row[pk] != null ? String(row[pk]) : String(i);
        const name = this.entityName(t, row, labelCol, pkVal);
        names.push(name);

        const observations: Observation[] = [];
        for (const c of cols) {
          if (fkFrom.has(c.name)) continue; // FK columns become edges, not observations
          const text = this.cellObservation(c.name, row[c.name]);
          if (text) observations.push({ text, sourceAdapter: this.id, locator: `table:${t}/row:${pkVal}`, source: filePath });
        }
        entities.push({ name, entityType: t, files: [filePath], observations });

        for (const col of idxCols) {
          if (row[col] == null) continue;
          const key = `${t}␟${col}`;
          if (!index.has(key)) index.set(key, new Map());
          index.get(key)!.set(String(row[col]), name);
        }
      });
      rowsByTable.set(t, { rows, names });
    }

    // ── pass 2: foreign keys → edges (child row → referenced parent row) ──
    for (const t of tables) {
      const { fks } = schema.get(t)!;
      if (fks.length === 0) continue;
      const { rows, names } = rowsByTable.get(t)!;
      rows.forEach((row, i) => {
        for (const fk of fks) {
          const val = row[fk.from];
          if (val == null) continue;
          const parent = index.get(`${fk.table}␟${fk.to}`)?.get(String(val));
          if (!parent) continue; // target row not emitted (capped / missing) → no dangling edge
          relations.push({ from: names[i], to: parent, relationType: [this.fkPredicate(fk)] });
        }
      });
    }

    return { entities, relations };
  }

  // ── sql.js helpers ──────────────────────────────────────────────────────────

  /** First result set's single column as a string[] (empty when no rows). */
  private queryColumn(db: Database, sql: string): string[] {
    const res = db.exec(sql);
    return res.length ? res[0].values.map((r) => String(r[0])) : [];
  }

  /** First result set as an array of column→value row objects. */
  private queryRows(db: Database, sql: string): Record<string, unknown>[] {
    const res = db.exec(sql);
    if (!res.length) return [];
    const { columns, values } = res[0];
    return values.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
  }

  private userTables(db: Database): string[] {
    return this.queryColumn(
      db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );
  }

  private tableInfo(db: Database, table: string): ColInfo[] {
    return this.queryRows(db, `PRAGMA table_info("${table.replace(/"/g, '""')}")`).map((r) => ({
      name: String(r.name),
      type: String(r.type ?? ""),
      pk: Number(r.pk) > 0,
    }));
  }

  private fkList(db: Database, table: string): FkInfo[] {
    return this.queryRows(db, `PRAGMA foreign_key_list("${table.replace(/"/g, '""')}")`).map((r) => ({
      from: String(r.from),
      table: String(r.table),
      to: String(r.to),
    }));
  }

  private selectRows(db: Database, table: string): Record<string, unknown>[] {
    const cap = this.opts.maxRowsPerTable;
    const rows = this.queryRows(db, `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${cap + 1}`);
    if (rows.length > cap) {
      this.logger.warn(
        `SQLite adapter: table '${table}' exceeds maxRowsPerTable=${cap}; emitting the first ${cap} rows (raise adapters.sqlite.maxRowsPerTable to include more).`
      );
      return rows.slice(0, cap);
    }
    return rows;
  }

  // ── mapping helpers ───────────────────────────────────────────────────────

  private pickLabelCol(cols: ColInfo[]): string | null {
    for (const want of LABEL_COLS) {
      const hit = cols.find((c) => c.name.toLowerCase() === want);
      if (hit) return hit.name;
    }
    return null;
  }

  private entityName(table: string, row: Record<string, unknown>, labelCol: string | null, pkVal: string): string {
    if (labelCol) {
      const v = row[labelCol];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
    return `${table}#${pkVal}`;
  }

  /** Render a non-FK cell as an observation; skip nulls/empties/blobs. */
  private cellObservation(col: string, value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) return null; // BLOB — skip
    const s = String(value).trim();
    return s ? `${col}: ${s}` : null;
  }

  /** Predicate for a FK edge: the child column minus a trailing id suffix, else the parent table. */
  private fkPredicate(fk: FkInfo): string {
    const stripped = fk.from.replace(/[_-]?id$/i, "").trim();
    return (stripped || fk.table).toLowerCase();
  }
}
