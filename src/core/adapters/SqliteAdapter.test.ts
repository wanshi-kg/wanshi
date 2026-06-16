import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import initSqlJs from "sql.js";
import { SqliteAdapter } from "./SqliteAdapter";
import { stubLogger } from "../../__tests__/helpers";
import { obsText } from "../../types";

const OPTS = { extensions: [".db", ".sqlite", ".sqlite3"], maxRowsPerTable: 5000, excludeTables: [] };

async function makeDbFile(dir: string, build: (db: any) => void, name = "data.db"): Promise<string> {
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve("sql.js")), f) });
  const db = new SQL.Database();
  build(db);
  const buf = Buffer.from(db.export());
  db.close();
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

describe("SqliteAdapter", () => {
  const adapter = new SqliteAdapter(OPTS, stubLogger());
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kgsqlite-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("maps tables→types, rows→entities (by label), FK→edge, with stamped provenance", async () => {
    const dbPath = await makeDbFile(tmp, (db) => {
      db.run("CREATE TABLE authors(id INTEGER PRIMARY KEY, name TEXT, country TEXT)");
      db.run("CREATE TABLE books(id INTEGER PRIMARY KEY, title TEXT, author_id INTEGER REFERENCES authors(id))");
      db.run("INSERT INTO authors VALUES (1,'Borges','AR')");
      db.run("INSERT INTO books VALUES (10,'Ficciones',1)");
    });

    expect(adapter.canHandle(dbPath)).toBe(true);
    const g = (await adapter.extract(dbPath))!;

    const borges = g.entities.find((e) => e.name === "Borges");
    const book = g.entities.find((e) => e.name === "Ficciones");
    expect(borges?.entityType).toBe("authors"); // table → entityType
    expect(book?.entityType).toBe("books"); // row named by label column (title)

    // non-FK column → provenance-stamped observation
    const countryObs = borges!.observations.find((o) => obsText(o).startsWith("country"));
    expect(countryObs).toMatchObject({ sourceAdapter: "sqlite", locator: "table:authors/row:1", source: dbPath });

    // FK → edge (book → author), predicate from the FK column minus _id
    const edge = g.relations.find((r) => r.from === "Ficciones" && r.to === "Borges");
    expect(edge?.relationType).toEqual(["author"]);
    // the FK column itself is an edge, NOT a stray observation on the book
    expect(book!.observations.some((o) => obsText(o).startsWith("author_id"))).toBe(false);
  });

  it("names a row <table>#<pk> when no label column exists", async () => {
    const dbPath = await makeDbFile(tmp, (db) => {
      db.run("CREATE TABLE parts(id INTEGER PRIMARY KEY, qty INTEGER)");
      db.run("INSERT INTO parts VALUES (42, 7)");
    });
    const g = (await adapter.extract(dbPath))!;
    expect(g.entities[0].name).toBe("parts#42");
  });

  it("skips excluded tables", async () => {
    const a = new SqliteAdapter({ ...OPTS, excludeTables: ["secrets"] }, stubLogger());
    const dbPath = await makeDbFile(tmp, (db) => {
      db.run("CREATE TABLE secrets(id INTEGER PRIMARY KEY, token TEXT)");
      db.run("CREATE TABLE notes(id INTEGER PRIMARY KEY, name TEXT)");
      db.run("INSERT INTO secrets VALUES (1,'hunter2')");
      db.run("INSERT INTO notes VALUES (1,'hello')");
    });
    const g = (await a.extract(dbPath))!;
    expect(g.entities.some((e) => e.entityType === "secrets")).toBe(false);
    expect(g.entities.some((e) => e.entityType === "notes")).toBe(true);
  });

  it("canHandle rejects a .db file that is not actually SQLite (header sniff)", async () => {
    const fake = path.join(tmp, "notreally.db");
    fs.writeFileSync(fake, "this is plain text, not a database at all");
    expect(adapter.canHandle(fake)).toBe(false);
  });

  it("does not claim a non-.db extension", () => {
    expect(adapter.canHandle("/x/notes.md")).toBe(false);
  });

  it("returns null for a SQLite db with no user tables", async () => {
    // create+drop initializes the file (header written) while leaving no user tables.
    const dbPath = await makeDbFile(tmp, (db) => db.run("CREATE TABLE t(x); DROP TABLE t;"));
    expect(adapter.canHandle(dbPath)).toBe(true); // valid SQLite header
    expect(await adapter.extract(dbPath)).toBeNull(); // ...but nothing to emit
  });
});
