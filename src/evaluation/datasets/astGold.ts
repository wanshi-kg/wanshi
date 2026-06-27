import { default as DocumentOutline } from '@wanshi-kg/outlion';
import {
  MODULE_MARKER,
  REFERENCE_KIND_TO_PREDICATE,
  shouldSeedSymbol,
} from '../../shared/utils/astSymbols';
import { Triplet } from './IDataset';

/**
 * AST-derived code gold — the deterministic oracle for the code corpus.
 *
 * Mirrors `AstSeedService.toGraph` (src/core/processor/ast) exactly — same
 * `shouldSeedSymbol` filter, same qualified→simple `resolve`, same
 * `REFERENCE_KIND_TO_PREDICATE` (calls→`calls`, imports→`depends_on`), same
 * self-loop/dup guard — so the gold IS "what the deterministic seed knows" about a
 * file's call/import graph. The harness scores the **pure-LLM** extraction (gold-compare
 * calls `kgBuilder.build()` directly, the AST seed is NOT in that path), so deriving the
 * gold from the same parser is NOT circular: the model never sees this output.
 *
 * Only JS/TS/Python carry an outlion `references.scm` (calls/imports edges); other
 * grammars yield definitions but no relations — hence the code corpus is one of those
 * three languages.
 */

const generator = new DocumentOutline();

export interface CodeGold {
  /** Definition names — node-capture gold. */
  symbols: string[];
  /** `calls` + `depends_on` edges — the relation gold. */
  triples: Triplet[];
}

const EMPTY: CodeGold = { symbols: [], triples: [] };

/** Whether outlion has a grammar for this extension (no grammar → no gold). */
export function isCodeSupported(ext: string): boolean {
  return generator.isSupported(ext);
}

/**
 * Extract the gold call/import graph for one file.
 *
 * @param content     File source.
 * @param ext         Extension without the dot (e.g. "py", "ts").
 * @param moduleName  Stable name for the file's module node (the `depends_on` subject
 *                    and the resolution target for top-level `<module>` call sites) —
 *                    typically the file path relative to the corpus root.
 */
export async function extractCodeGold(content: string, ext: string, moduleName: string): Promise<CodeGold> {
  if (!generator.isSupported(ext)) return EMPTY;
  const table = await generator.extractSymbolsSafe(content, ext);
  if (!table.symbols.length) return EMPTY;

  const qualifiedToName = new Map<string, string>();
  const symbols: string[] = [];
  for (const sym of table.symbols) {
    if (!shouldSeedSymbol(sym)) continue;
    qualifiedToName.set(sym.qualifiedName, sym.name); // last writer wins — same simple name
    symbols.push(sym.name);
  }

  const resolve = (ref: string): string =>
    ref === MODULE_MARKER ? moduleName : qualifiedToName.get(ref) ?? ref;

  const triples: Triplet[] = [];
  const seen = new Set<string>();
  const push = (subject: string, predicate: string, object: string): void => {
    if (!subject || !object || subject === object) return;
    const key = `${subject}␟${predicate}␟${object}`;
    if (seen.has(key)) return;
    seen.add(key);
    triples.push({ subject, predicate, object });
  };

  for (const ref of table.references) {
    const predicate = REFERENCE_KIND_TO_PREDICATE[ref.kind];
    if (ref.kind === 'imports') push(moduleName, predicate, ref.to);
    else push(resolve(ref.from), predicate, resolve(ref.to));
  }

  return { symbols, triples };
}
