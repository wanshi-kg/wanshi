import * as fs from "fs";
import * as path from "path";
import { SYMBOL_SCHEMA_VERSION } from "@wanshi-kg/outlion";
import { Logger } from "../../../shared";
import { SymbolTable } from "../../../shared/utils/astSymbols";

/**
 * Content-hash → SymbolTable cache sidecar (`<output>.ast-cache.json`) for the AST
 * seed pass (Phase 8). A hit lets `AstSeedService` skip re-parsing unchanged file
 * content entirely — the "re-running on an unchanged file is a no-op" gate. Modeled
 * on {@link CorpusProfileStore}: a missing or garbled sidecar is non-fatal (the pass
 * just re-extracts), and entries written under an older `SYMBOL_SCHEMA_VERSION` are
 * dropped on load (treated as a miss) so a dependency bump can't feed stale shapes.
 */
export class AstSymbolStore {
  private cache = new Map<string, SymbolTable>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly path: string, private readonly logger: Logger) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.path, "utf-8"));
      const entries = parsed && typeof parsed === "object" ? parsed.entries : undefined;
      if (entries && typeof entries === "object") {
        for (const [hash, table] of Object.entries(entries)) {
          const t = table as SymbolTable;
          if (t && t.schemaVersion === SYMBOL_SCHEMA_VERSION) this.cache.set(hash, t);
        }
      }
      this.logger.info(`Loaded ${this.cache.size} cached AST symbol table(s) from ${this.path}`);
    } catch (error) {
      this.logger.warn(`Could not read AST cache at ${this.path} (ignored): ${error}`);
    }
  }

  get(hash: string): SymbolTable | undefined {
    return this.cache.get(hash);
  }

  set(hash: string, table: SymbolTable): void {
    this.cache.set(hash, table);
    this.dirty = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const dir = path.dirname(this.path);
    if (dir && !fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
    const entries = Object.fromEntries(this.cache);
    await fs.promises.writeFile(this.path, JSON.stringify({ version: SYMBOL_SCHEMA_VERSION, entries }));
    this.dirty = false;
  }
}
